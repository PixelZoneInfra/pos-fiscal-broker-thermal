# Odzyskanie blokady po zaniku zasilania

Przycisk `Odzyskaj po awarii.vbs` przygotowano do istniejącego brokera Thermal V2.
Nie uruchamia drukarki, nie drukuje, nie zamyka transakcji fiskalnej i nie resetuje historii.

## Które pliki są czym

| Plik | Rola | Co robić |
| --- | --- | --- |
| `operations.lock` | Mały plik tekstowy z PID właściciela dziennika | Normalnie broker tworzy przy starcie i usuwa przy prawidłowym zamknięciu. Po awarii może pozostać. Przycisk archiwizuje tylko potwierdzoną osieroconą blokadę |
| `operations.jsonl` | Trwały dziennik stanów operacji, wyników, liczników i sum kontrolnych | Zachować między sesjami i aktualizacjami. Nie usuwać, nie zerować ani nie przenosić poza aktywną ścieżkę w celu uruchomienia pustej historii |
| `local-results/broker-start.log` | Log diagnostyczny startu | Odczytać, jeśli API nie wystartuje. Sam komunikat „kod 0” nie wskazuje przyczyny |
| `local-results/broker-control.json` | PID/identyfikator instancji i token lokalnego sterowania | Nie publikować zawartości. Nie jest dziennikiem fiskalnym |

W tej wersji nie ma pliku danych fiskalnych o nazwie `operation.log` ani `operations.json`.
Sprawdź pełną nazwę i rozszerzenie w Eksploratorze. Jeśli przeniesiono plik inny niż
`operations.lock`, zachowaj go i ustal jego rolę przed dalszą sprzedażą. Nie łącz ręcznie
dwóch dzienników ani nie podmieniaj pliku przy działającym brokerze.

Domyślna ścieżka Windows dla obecnego `package.json`:
`%APPDATA%\pos-fiscal-broker-thermal\fiscal-operations\`.
Pełną używaną ścieżkę wypisuje istniejący broker w `local-results\broker-start.log`.
Przycisk nie przeszukuje innych katalogów i nie zgaduje plików do usunięcia.
Używa zawsze tej ścieżki w AppData aktualnego użytkownika Windows, niezależnie
od folderu, do którego rozpakowano brokera. Komunikat o braku blokady pokazuje
sprawdzony katalog. `Zamknij.vbs` zatrzymuje działającego brokera; osieroconą
blokadę po awarii usuwa z aktywnego katalogu `Odzyskaj po awarii.vbs`.

## Instalacja i użycie

1. Rozpakuj pakiet do **dotychczasowego folderu brokera**, obok `Uruchom na nowo.vbs`.
   Zachowaj katalog `tools`, istniejące ustawienia i `node_modules`. Node.js jest już
   wymagany przez pozostałe przyciski. Nowych zależności npm nie ma.
2. Używaj po awarii, gdy broker jest wyłączony i nie trwa obsługa klienta w POS.
   Zakończ działające instancje normalnie; wątpliwy proces najprościej usunąć z tej
   sytuacji przez ponowne uruchomienie Windows. Przycisk nie używa taskkill.
3. Kliknij `Odzyskaj po awarii.vbs`. Jeśli port 3030 albo proces Electron/brokera
   nadal działa, plik blokady zostanie zachowany. Sam brak API nie wystarcza
   do uznania, że broker zakończył pracę. Nierozpoznany proces Node także powoduje
   odmowę; działający `electron.exe` jest traktowany jako możliwa inna kopia brokera.
   Skrypt rozpoznaje własny Node i bezpośredni proces `wscript.exe`/`cscript.exe`
   uruchamiający dokładnie ten przycisk, więc nie blokuje się na sobie.
   Windows może ponownie przydzielić dawny PID. Oprócz własnych procesów odzyskiwania
   taki PID można pominąć wyłącznie wtedy, gdy lista procesów potwierdza start
   późniejszy niż powstanie i ostatnia modyfikacja blokady (z sekundowym marginesem).
   Osobne sprawdzenie obecności brokera nadal obowiązuje, także po ponownym użyciu PID.
4. Po pozytywnym wyniku wybierz istniejące `Uruchom na nowo.vbs`, a potem `Sprawdz stan.vbs`.
   Tryb startu nadal wybiera dotychczasowy zapis profilu; odzyskiwanie go nie zmienia.
5. Jeżeli status pokaże niejednoznaczną operację, uzgodnij ją z paragonem/drukarką
   i sprzedażą dotychczasowym procesem. Samo odzyskanie blokady nie rozstrzyga fiskalizacji.

Nie uruchamiaj równolegle ręcznego `npm start`/Electron podczas odzyskiwania.
Przycisk współdzieli blokadę z istniejącym panelem start/stop/restart i ponawia
sprawdzenia przed przeniesieniem pliku.

Kopia znajduje się w:
`fiscal-operations\lock-recovery-backups\<czas-UUID>\`.
Zawiera `operations.lock`, kopię niezmienionego `operations.jsonl` i `recovery.json`
z hashem kopii. Przy błędzie kontroli po utworzeniu kopii może pozostać katalog
kopii bez pliku `operations.lock`: oznacza to, że blokady nie przeniesiono.
Oryginalnego dziennika skrypt nie otwiera do zapisu, nie przycina i nie zmienia
stanów `unknown`/`in_progress`. Uszkodzony dziennik nadal odmówi pracy przy starcie.

Nie ma automatycznego czyszczenia na każdej sesji. Zachowanie `operations.jsonl`
umożliwia zwrócenie zapisanego wyniku tego samego operation_id po restarcie,
zamiast ponownego wydrukowania paragonu. `in_progress` przechodzi przy normalnym
starcie brokera do `unknown`; wymaga sprawdzenia, a nie ponowienia w ciemno.

## Weryfikacja wydania

Testy automatyczne sprawdzają izolowane katalogi, żywe PID, zajęty port, drugi
proces, nieprawidłowy lock, konflikt start/recovery, błędy kontroli, ponowienie,
kopię bajtową i odtworzenie potwierdzonych oraz przerwanych operacji.
Windows CI dodatkowo uruchamia prawdziwe WMI i VBS przez `cscript.exe` w fixture.
Test po zakończeniu procesów testowych Node wykonuje pełne odzyskanie osieroconej
blokady przez VBS/CIM w izolowanym AppData i sprawdza odmowę dla żywego procesu
bez API. Obejmuje folder ze spacjami i nazwą `pos-fiscal-broker`, która wcześniej
powodowała błędne rozpoznanie własnego hosta VBS jako brokera.
Nie jest to potwierdzenie kliknięcia na stanowisku Windows operatora ani test
fizycznej drukarki. Nie wykonuj prawdziwego wydruku tylko po to, by sprawdzić VBS.

Źródła kontraktu: `main.js`, `operation-journal.js`, `tools/broker-panel.js` tej
wersji brokera; domyślna ścieżka danych według
[Electron app.getPath](https://www.electronjs.org/docs/latest/api/app#appgetpathname),
kontrola istnienia PID sygnałem 0 według
[Node.js process.kill](https://nodejs.org/api/process.html#processkillpid-signal).
