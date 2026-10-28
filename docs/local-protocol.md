# HeliaLux local protocol

A HeliaLux AppControl lamp can be controlled on the local network without the
MyJUWEL cloud. The lamp runs the Klyqa (QConnex) device firmware, and this is
Klyqa's local protocol: a UDP broadcast for discovery, a TCP connection that
the lamp opens back to the client, and AES-encrypted JSON over that connection.

Everything below was verified on 2026-10-28 against two lamps on firmware
V2.0.1.3 (SDK 1.1.0.1020), by packet capture of the JUWEL phone app and with a
standalone probe. The crypto details match the open-source
[klyqa-ctl](https://github.com/Klyqa/klyqa-ctl) (MIT).

## Overview

```
 client (Homey, phone)                        lamp
   |                                            |
   |  UDP :2222 -> broadcast  "QCX-SYN"         |
   |------------------------------------------->|
   |  UDP :2222 <- lamp       "QCX-ACK"         |
   |<-------------------------------------------|
   |                                            |
   |  TCP: lamp connects to client :3333        |
   |<===========================================|
   |  type 0  ident (plaintext JSON)            |
   |<-------------------------------------------|
   |  type 1  client nonce (8 bytes)            |
   |------------------------------------------->|
   |  type 1  lamp nonce (8 bytes)              |
   |<-------------------------------------------|
   |  type 2  encrypted request                 |
   |------------------------------------------->|
   |  type 2  encrypted reply                   |
   |<-------------------------------------------|
```

The client is the server: the lamp has no open TCP ports (a full port scan
shows everything closed or filtered); only UDP 2222 answers.

## 1. Discovery: SYN/ACK on UDP 2222

The client binds UDP port 2222 with broadcast enabled and sends the ASCII
string `QCX-SYN` to port 2222 on the broadcast address (`255.255.255.255`
and/or the subnet broadcast, e.g. `192.168.1.255`).

- Every lamp that hears it answers `QCX-ACK` from its port 2222 to the
  client's port 2222.
- The JUWEL phone app sends `QCX-SYN;<unit_id>` to address one lamp. A plain
  `QCX-SYN` reaches every lamp on the network.
- The phone app repeats the SYN about once a second. While SYNs keep coming,
  a lamp dials in again about every 5 seconds.
- The client also receives its own broadcast; ignore anything starting with
  `QCX-SYN`.

The broadcast does not cross subnets or VLANs, so the client and the lamps
must be on the same network.

## 2. The lamp dials the requester on TCP 3333

Right after the ACK, the lamp opens a TCP connection to the address the SYN
came from, on port **3333**. The client must already be listening on
TCP 3333.

Only one process per host can listen on 3333 (and bind 2222), so a probe, the
Homey app and `nc -l 3333` cannot run on the same machine at the same time.
Different hosts are fine: the phone app and another client can both be
connected to the same lamp.

## 3. Framing

Every message on the TCP connection, in both directions, is one frame:

| Bytes | Field |
|---|---|
| 0–1 | payload length, big-endian |
| 2–3 | type, big-endian |
| 4… | payload |

| Type | Direction | Payload |
|---|---|---|
| `0x0000` | lamp → client | plaintext JSON ident, sent first |
| `0x0001` | both | 8 random bytes (nonce): client first, then lamp |
| `0x0002` | both | AES-encrypted JSON, a multiple of 16 bytes |

### Ident (type 0)

```json
{
  "type": "ident",
  "ident": {
    "fw_version": "V2.0.1.3",
    "sdk_version": "1.1.0.1020",
    "fw_build": "Jul 18 2025 10:26:04",
    "hw_version": "1",
    "manufacturer_id": "911886d4-520b-4ea2-9a76-d366a2723f14",
    "product_id": "@juwel.lighting.helialux1",
    "product_name": "Juwel Helialux",
    "device_name": "Klyqa Device",
    "unit_id": "A8E552XXXXXX",
    "timezone": "CET-1CEST,M3.5.0,M10.5.0/3",
    "order": 0,
    "group": ""
  }
}
```

`unit_id` is the lamp's MAC address (OUI `A8:E5:52`, Juwel Aquarium AG & KG)
and identifies the lamp. It does not change with the IP address.

## 4. Encrypted frames

After the ident, the client sends its 8-byte nonce (type 1) and the lamp
answers with its own. Both sides then set up **AES-128-CBC**:

| Direction | Key | IV (16 bytes) |
|---|---|---|
| client → lamp | `aesKey` | client nonce + lamp nonce |
| lamp → client | `aesKey` | lamp nonce + client nonce |

- Each direction uses one cipher for the whole connection: the CBC chain
  carries over from one frame to the next. Do not reset the IV per frame.
- Plaintext is UTF-8 JSON, padded with spaces (`0x20`) to a multiple of
  16 bytes. There is no PKCS#7 padding; trim trailing whitespace after
  decrypting.
- A wrong key or a wrong IV order decrypts to garbage instead of JSON.

### The key

The key is the device's `aesKey` from the MyJUWEL cloud (`GET /settings`,
`devices[].aesKey`, a 32-character hex string = 16 bytes). Match a lamp to its
key with `devices[].localDeviceId`, which equals the ident's `unit_id`. The
key is per lamp. It is the only thing local control needs from the cloud.

Whether the key changes after a factory reset or re-onboarding is not known
yet.

## 5. Messages

Requests are answered in order, one reply per request, and replies carry no
request id. Send one request at a time and wait for its reply.

### Status

```json
{"type":"request"}
```

```json
{
  "type": "status",
  "error": [],
  "active_preset": 1,
  "transitionTime": 1000,
  "color": {"red": 255, "green": 0, "blue": 0},
  "white": {"value": 0},
  "brightness": {"percentage": 44},
  "status": "on",
  "mode": "rgb",
  "wifi_parameters": {"rssi": -51, "security": 3, "channel": 3}
}
```

- `mode`: `auto` while the schedule runs, `rgb` when paused or in manual.
- `color`, `white`, `brightness` and `status` are the stored **manual**
  settings. While the schedule runs, they say nothing about the light the
  schedule is showing.
- The reported colour is not always what the lamp outputs: a lamp reported
  white 255/255/255 while showing its manual red. Writing the colour
  explicitly fixed it.

### Manual light

```json
{"type":"request","status":"on","brightness":{"percentage":44},"color":{"red":255,"green":255,"blue":255},"white":{"value":255}}
{"type":"request","status":"off"}
```

The reply is a status message. Send colour, white and brightness together
when switching to manual light, so the output matches what was asked.

While the schedule runs (`mode: auto`), the lamp refuses the write. The reply
echoes the requested values but carries an error, and the next status request
shows the old values:

```json
{"type":"status","error":["AUTO mode is running. Discarding!"],"mode":"auto", ...}
```

While paused, writes take effect within about a second (`transitionTime`
1000 ms). Unlike the cloud, the lamp does not drop a write that repeats the
current value.

### Pausing and resuming the schedule

```json
{"type":"preset","action":"pause","timeout":600}
{"type":"preset","action":"resume"}
```

Both reply `{"type":"success","error":[]}`. Pause switches `mode` to `rgb`
and keeps showing the schedule's light until a manual write. Resume switches
back to `auto`, and the schedule's light returns immediately, even if the
manual status is `off`. `timeout` is in seconds. These are the same JSON
bodies as the cloud's `POST /device/{id}/command`.

### Other commands

`klyqa-ctl` also sends `{"type":"ping"}`, `{"type":"reboot"}`,
`{"type":"routine","action":"list"}` and fade settings
(`{"type":"request","fade_in":…,"fade_out":…}`). These have not been tried on
a HeliaLux.

## 6. Connection behaviour

- A connection stays open. One was held for 4 minutes with idle gaps of up to
  2 minutes; every request was answered and the lamp never dialled in again.
  One persistent connection per lamp is enough; send a new `QCX-SYN` only to
  find a lamp or to reconnect after the connection drops.
- The phone app and another client can be connected to the same lamp at the
  same time. Both keep working, and changes made in the phone app show up in
  the other client's next status request.

## 7. Trying it by hand

Listen for the lamp in one terminal (start this first):

```sh
nc -l 3333 | strings
```

Broadcast one SYN and print the replies in another:

```sh
python3 -c "
import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1)
s.bind(('',2222)); s.settimeout(3)
s.sendto(b'QCX-SYN',('255.255.255.255',2222))
while True:
  try: d,a=s.recvfrom(1024); print(a[0], d)
  except socket.timeout: break
"
```

The second terminal shows your own `QCX-SYN` and a `QCX-ACK` from each lamp;
the first shows one lamp's ident. `nc` accepts a single connection, so other
lamps are refused.
