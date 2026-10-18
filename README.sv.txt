Styr din JUWEL-akvarieutrustning från Homey via MyJUWEL-molnet, samma tjänst som den officiella JUWEL AppControl-appen använder.

Enheter som stöds

- JUWEL HeliaLux (belysning): stöds och är testad.
- JUWEL SmartFeed (foderautomat): stöds, men är otestad.
- JUWEL EccoFlow (pump): grundläggande stöd, otestad.

Har du en SmartFeed eller EccoFlow? Rapportera vad som fungerar på github.com/moogblob/homey-juwel-appcontrol/issues

Det här kan du göra med en HeliaLux

- Tända och släcka lampan
- Ställa in den totala ljusstyrkan
- Välja färg med Homeys färghjul
- Ställa in den vita kanalen separat
- Växla mellan Schema (lampan följer dygnsprofilen som är sparad i MyJUWEL) och Manuellt (lampan visar värdena som ställts in i Homey)
- Använda allt detta i Flows, precis som med vilken Homey-lampa som helst

Det här kan du göra med en SmartFeed

- Mata nu, med den mängd som är inställd på foderautomaten eller en vald mängd (även i Flows)
- Ställa in fodermängden, och mängden för knappen på foderautomaten
- Slå på och av foderautomaten och dess statuslampa
- Få ett larm när foderbehållaren är tom eller foderautomaten rapporterar ett fel
- Se när fiskarna senast matades, och starta ett Flow när de matas
- Matningsscheman går inte att ändra från Homey ännu. Använd JUWEL-appen.

Det här kan du göra med en EccoFlow

- Slå på och av pumpen, och slå på matningspaus och effektbegränsning, om pumpen tillåter det
- Se driftläge och flöde
- Ändra driftläge och nollställa underhållstimrarna i Flows
- Vattentemperatur och pumplarm är inte tillgängliga, eftersom JUWEL inte beskriver dem för appar

Det här kan du förvänta dig

- När du ändrar färg, ljusstyrka eller vitt på en HeliaLux går lampan över till manuellt läge. Det varar i 1 timme, sedan återgår lampan till sitt schema av sig själv, precis som förhandsvisningen i JUWEL-appen.
- Homey hämtar varje enhets status från molnet var 30:e sekund som standard. Du kan välja mellan 10 och 3600 sekunder i enhetens inställningar. En ändring som görs i JUWEL-appen eller direkt på enheten kan ta så lång tid innan den syns i Homey.
- Medan en HeliaLux är i schemaläge visar Homey ljuset som schemat ger just nu, uträknat från den aktiva profilen. Ljusstyrkan följer då den starkaste kanalen, så ett svagt nattljus visas som några få procent.
- Allt går via MyJUWEL-molnet, så dina enheter och Homey behöver internetåtkomst. Om molnet ligger nere kan Homey inte styra dina enheter.
- Om en enhet är offline i MyJUWEL visas den som otillgänglig i Homey.

Kom igång

1. Se till att dina enheter är installerade och fungerar i den officiella JUWEL AppControl-appen.
2. Installera den här appen och öppna dess inställningar.
3. Ange e-postadressen och lösenordet för ditt MyJUWEL-konto och tryck på Spara.
4. Lägg till en enhet, välj HeliaLux, SmartFeed eller EccoFlow och välj dina enheter.

Om MyJUWEL inte godkänner din e-postadress eller ditt lösenord visas dina enheter som otillgängliga tills du rättar uppgifterna i appens inställningar.

Ansvarsfriskrivning

Det här är en inofficiell community-app. Den är inte utvecklad, godkänd eller supportad av JUWEL Aquarium. Den använder MyJUWEL-molnets API, som inte är offentligt dokumenterat och kan ändras utan förvarning. Detaljerna om API:et kommer från Home Assistant-integrationen av Melle79 (github.com/Melle79/juwel-appcontrol).
