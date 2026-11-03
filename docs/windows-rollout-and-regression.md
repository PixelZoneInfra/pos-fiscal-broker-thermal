# Jedna sesja wdrożenia i regresji brokera na Windows

**Pierwsze uruchomienie bez edytowania plików: [START-TUTAJ.md](../START-TUTAJ.md).** Poniżej jest pełny techniczny plan odbioru API; nie wszystkie jego kroki są wymagane do pierwszego odczytu drukarki i testu obecnego POS.

**Obsługa wersji v2:** okno `index.html` jest ukryte również w trybach diagnostycznych. Do zatrzymywania służy `Zamknij.vbs`; samo zamknięcie CMD nie jest potwierdzeniem zatrzymania brokera. `Uruchom na nowo.vbs` zawsze włącza tryb obecnego POS, więc nie zastępuje startu trybu diagnostycznego ani testu rezerwacji. Skróty VBS można umieścić na pulpicie, pozostawiając oryginały i `tools` w katalogu instalacji. [Instrukcja codzienna](../tools/INSTALACJA.txt).

Wersja obejmuje fundament z PR #2 oraz kolejny PR rezerwacji. Pobieramy **cały końcowy branch** `feature/fiscal-reservations-and-regression-20261101`, nie stare `main` i nie dwa wybrane pliki. Nowy PR jest skierowany do `feature/fiscal-safety-stage-1-20261101`; po ewentualnym scaleniu do tego brancha zawiera on oba etapy. Samo otwarcie/scalenie PR nie instaluje brokera na komputerze.

Cel sesji: sprawdzić komunikację XL2, wszystkie polecenia dostępne z POS, nowy kontrakt rezerwacji i zgodność dotychczasowego POS. Odbiorca kolejki, kod POS, centralna baza, płatności, faktury i poczta nie są wdrażane tym pakietem. Rzeczywiste wydruki/operacje kasowe operator wykonuje dopiero dla uzgodnionych transakcji. Zapis JSON z testów nie zastępuje oceny wydruku.

## 1. Przygotowanie przed wyjazdem / przed przerwą w obsłudze

1. Zachować **cały aktualnie działający lokalny katalog**, wraz z `node_modules`, ewentualnymi lokalnymi zmianami i sposobem startu. Backup GitHub nie dowodzi, że lokalne pliki odpowiadają `main`. Zanotować faktyczny COM, parametry połączenia i adres brokera używany przez przeglądarkę POS.
2. Nowy ZIP/checkout rozpakować do osobnego katalogu, np. `C:\PixelZone\broker-test`. `package.json` oraz pliki CMD muszą być bezpośrednio w tym katalogu. Nie nadpisywać działającej wersji i nie mieszać jej modułów z nowymi.
3. Wymagany Node.js/npm; do testów Node co najmniej 20. W CMD:

```bat
cd /d "C:\PixelZone\broker-test"
node --version
npm --version
setup-windows.cmd
```

Skrypt wykonuje zwykłe `npm ci` (z instalacją Electron), potem `npm test`; **nie uruchamia brokera i nie korzysta z USB**. Przy błędzie instalacji lub testów przerwać. `--ignore-scripts` jest wyłącznie opcją CI, nie przygotowaniem komputera do startu Electron.

Do pierwszego odczytu drukarki nie potrzeba konfiguracji. Przed testem przez stronę POS można użyć kreatora: skopiować cały adres swojej strony POS z przeglądarki, następnie uruchomić:

```bat
configure-pos.cmd
```

Wkleić pełny adres do pytania w CMD i nacisnąć Enter. Kreator sam wyodrębnia adres serwera POS i zapisuje `broker-local.cmd`; zachowuje pozostałe ustawienia i kopię `.bak`. Nie trzeba otwierać Notatnika, rozumieć CORS ani ręcznie wpisywać zmiennych. Ta lokalna konfiguracja obsługuje przeglądarkę POS i jest wczytywana przez skrypty startowe. Bez niej pozostają dostępne odczyty z narzędzia CMD. Pliki są ignorowane przez Git; kreator nie zmienia ENV na Render, globalnych ustawień Windows ani komend drukarki.

Domyślnie używany jest nadal COM3, 115200/8/N/1. Jeśli **działająca lokalna wersja** używa innego COM, wpisać go w tym samym pliku przez `set "FISCAL_SERIAL_PORT=COMx"`, podstawiając rzeczywistą nazwę. Nie zmieniać szybkości ani konfiguracji drukarki. Faktycznie wybrany port pokaże `/broker/status` jako `serialPort`. Numer zarządza się tylko w rejestrze strony; POS porównuje go z numerem rezerwacji/diagnostyki USB, a broker przed rozpoczęciem druku. Nie dopisujemy numeru do lokalnego ENV.

4. Przygotować dane konkretnych NOWYCH, uzgodnionych operacji: produkty i właściwe litery VAT, kwoty, NIP jeśli dotyczy, formy płatności, kwotę wpłaty/wypłaty i zakres raportu okresowego. Nie kopiować do ponownego fiskalizowania wcześniej wydrukowanej sprzedaży. Szablony JSON w `test-data-examples` wymagają uzupełnienia; skopiować je do ignorowanego `local-test-data`.
5. Ustalić identyfikator sesji, np. `banino-20261101`. Każda inna rzeczywista operacja ma inne ID. Ponowienie tej samej operacji zachowuje ID i payload, także po restarcie. Zachować je w protokole.
6. Zaplanować część z raportem dobowym przy rzeczywistym zamknięciu dnia. Nie wykonywać go „na próbę” kilka razy. Papier zapewnić także na raport okresowy. Nie testować uszkodzenia dysku ani awarii w trakcie fiskalizacji bez osobnej uzgodnionej procedury.

## 2. Początek sesji w lokalu — bez wydruków

1. Zakończyć bieżące operacje i potwierdzić brak otwartej transakcji. Zamknąć wszystkie karty/okna POS na tym komputerze i zatrzymać stary broker. Nie uruchamiać dwóch wersji do COM3. Nie zmieniać konfiguracji drukarki, stawek ani pamięci fiskalnej.
2. Zanotować model, firmware, numer unikatowy, ostatni numer dokumentu, licznik dobowy i stan gotówki. Zachować dotychczasowy dziennik `fiscal-operations`, jeśli już istnieje. Nie przenosić dziennika pomiędzy komputerami/oddziałami.
3. W pierwszym CMD:

```bat
cd /d "C:\PixelZone\broker-test"
start-diagnostics.cmd
```

Zostawić okno otwarte. Skrypt ustawia `FISCAL_DIAGNOSTICS_ONLY=true`, online=false, wymóg rezerwacji=false. Tryb ten blokuje nawet przypadkowe żądania druku/gotówki od pozostawionego klienta. Nadal nie otwierać POS.

4. W drugim CMD:

```bat
cd /d "C:\PixelZone\broker-test"
npm run check:broker -- --report local-results\01-diagnostics.json
```

Domyślny test wykonuje tylko pięć odczytów: `/broker/status`, `/status`, `/status/parsed`, `/cash/state`, `/device/diagnostics`. **Nie wywołuje GET `/cash/report`, bo ten drukuje.** Nie ponawia żądań automatycznie. Wynik jest lokalny; tokeny rezerwacji są maskowane.

5. Porównać odpowiedzi z urządzeniem: prawdziwy numer w `identity.uniqueNumber`, osobno programowany `status.uniqueId`, stawki VAT, liczniki i zegar. `printerClockBefore/After` to obserwacje zegara z dokładnością do minuty, a nie gwarantowany czas z paragonu. Sprawdzić `api_version: 2`, `capabilities.reservations: true`, `diagnosticsOnly: true`, pustą listę blokad i zdrowy dziennik. Błąd/rozbieżność oznacza STOP, nie przejście do drukowania.

6. Wciąż w trybie diagnostycznym można otworzyć POS wyłącznie do sprawdzenia połączenia w jego konsoli:

```js
fetch('http://localhost:3030/broker/status').then(r => r.json()).then(console.log)
```

Ma wrócić status nowej wersji z `diagnosticsOnly: true`. Sprawdzić także preflight nowych nagłówków, nadal bez wydruku:

```js
fetch('http://localhost:3030/broker/status', {
  headers: { 'X-Operation-Id': 'browser:probe', 'X-Printer-Reservation-Token': 'probe' }
}).then(r => r.json()).then(console.log)
```

To GET metadanych; token `probe` nie wykonuje ani nie rezerwuje urządzenia. Błąd CORS/połączenia wyjaśnić przed sprzedażą, porównując `window.location.origin` z konfiguracją. Potem ponownie zamknąć POS przed fazą rezerwacji. Przeglądarka jest osobnym punktem kontroli od testów HTTP na Node.

## 3. Rezerwacja bez wydruku

Kliknąć `Zamknij.vbs`, poczekać na potwierdzenie wyłączenia i uruchomić:

```bat
start-reservation-test.cmd
```

Ten tryb wymaga tokenów dla wszystkich nowych poleceń POS. **Nie otwierać w nim obecnego POS**, bo zapisuje rachunek przed wywołaniem drukarki i jeszcze nie pobiera tokenów.

W drugim CMD:

```bat
npm run check:broker -- --mode reservations --report local-results\02-reservations.json
```

Sprawdzane: przyznanie, publiczny odczyt bez sekretu, odmowa drugiej rezerwacji, blokada odczytu USB innego klienta, odmowa błędnego tokenu, odnowienie, zwolnienie i wygaśnięcie niewykorzystanej krótkiej rezerwacji. Skrypt nie wywołuje fiskalnych ani kasowych komend. Końcowy `/broker/status` ma `reservation: null` i pustą listę blokad.

## 4. Uzgodniony wydruk z tokenem, idempotencja i restart

Bezpośrednie żądanie paragonu tworzy dokument na drukarce **bez rachunku i rozchodu magazynu POS**. Taki test musi mieć uzgodnione ujęcie i odpowiadać konkretnej nowej operacji. Nie odtwarzać w ten sposób paragonu już wystawionego przez POS.

Uzupełnić `local-test-data\receipt-advanced.json` i ustawić ID sesji w drugim CMD:

```bat
set "SESSION=banino-20261101"
npm run check:broker -- --case receipt-advanced --payload local-test-data\receipt-advanced.json --operation-id "%SESSION%:advanced:01" --reserve --allow-device-action --report local-results\03-reserved-receipt.json
```

`--reserve` wykonuje pełny handshake brokera (nie zapisuje bazy POS). Zweryfikować fizyczny dokument, kwotę/płatności/NIP i metadane: `fiscal_confirmed`, numer dokumentu z `50#s`, licznik dobowy i numer urządzenia. Zanotować rzeczywiste oznaczenia z wydruku.

Powtórzyć **identyczne** polecenie z tym samym ID: jeden fizyczny paragon, wynik zapisany. Następnie zamknąć i uruchomić broker tym samym skryptem, ponowić identyczne polecenie: nadal brak nowego wydruku. Narzędzie sprawdza istniejący stan i broker porównuje payload; nie tworzy ponownej rezerwacji dla potwierdzonego wyniku. Zmiana ID oznacza NOWĄ operację, nie sprawdzenie poprzedniej.

Odczyt konkretnego wyniku:

```bat
npm run check:broker -- --case operation --id "%SESSION%:advanced:01" --report local-results\04-saved-operation.json
```

Po `unknown`/`in_progress` wstrzymać sesję. Odczyt wyniku jest dozwolony, lecz nie oznacza zgody na ponowienie. `reconcile` jedynie dopisuje dowody, nie usuwa blokady. Procedura ręcznej weryfikacji i lokalne narzędzie są w README; zachować dziennik. Nie usuwać dziennika ani nie wracać do starszego programu w celu obejścia blokady.

## 5. Macierz wszystkich API

Pełną listę narzędzia można wyświetlić bez połączenia z urządzeniem:

```bat
npm run check:broker -- --list
```

Dla indywidualnego polecenia urządzenia stosujemy wzór poniżej. Podać nowy `--operation-id` dla każdej innej operacji, wymagany plik `--payload` i `--reserve` w trybie z tokenami. Polecenia można także sprawdzić przez obecny POS w fazie 6. Testy automatyczne pokrywają wszystkie poniższe trasy; wynik sprzętowy zapisuje operator jako PASS / FAIL / SKIP z powodem.

```bat
npm run check:broker -- --case NAZWA --operation-id "%SESSION%:NAZWA:01" --reserve --allow-device-action
```

| Case / API | Skutek | Dane i oczekiwany wynik sprzętowy |
| --- | --- | --- |
| `broker-status`: GET `/broker/status` | Tylko metadane | Wersja 2, właściwy tryb, brak busy/blokad; token nie jest ujawniany |
| `status`: GET `/status` | Odczyt USB | Pełna ramka odpowiedzi, bez drukowania |
| `status-parsed`: GET `/status/parsed` | Odczyt USB | VAT, fiskalność, licznik i programowany identyfikator odpowiadają konfiguracji |
| `cash-state`: GET `/cash/state` | Odczyt USB | Gotówka zgodna ze stanem urządzenia |
| `diagnostics`: GET `/device/diagnostics` | Odczyt USB | Faktyczne ID, firmware, numer dokumentu, zegar i flagi |
| `receipt`: POST `/transaction/receipt` | FISKALIZACJA | `receipt.json`; prosty paragon, pełna kwota, `fiscal_confirmed` |
| `receipt-advanced`: POST `/transaction/receipt-advanced` | FISKALIZACJA | `receipt-advanced.json`; pozycje/płatności/NIP zgodne, część `$y` i stopka `$z` zakończone |
| `cashier-login`: POST `/cashier/login` | Polecenie kasjera / możliwy wydruk | `cashier.json`: `cashier`, `register`; przyjęcie i właściwy dokument/stan |
| `cashier-logout`: POST `/cashier/logout` | Polecenie kasjera / możliwy wydruk | Ten sam format, własne ID; zgodne wylogowanie |
| `cash-deposit`: POST `/cash/deposit` | RZECZYWISTA WPŁATA do stanu drukarki | `amount.json`; stan przed/po i potwierdzenie operacji |
| `cash-withdraw`: POST `/cash/withdraw` | RZECZYWISTA WYPŁATA ze stanu drukarki | `amount.json`; nie wpisywać operacji, której operator nie wykonał |
| `cash-report`: GET `/cash/report` | DRUKUJE | Raport gotówki zgodny; mimo GET wymaga zgody i stabilnego ID |
| `drawer-open`: POST `/cash-drawer/open` | Otwiera szufladę | Fizyczne otwarcie; brak nowego paragonu |
| `void-document`: POST `/transaction/void` | DRUKUJE dokument anulowany | Start i anulowanie w jednej operacji, bez skasowania zastanej transakcji |
| `reprint-last`: POST `/transaction/reprint-last` | DRUKUJE kopię niefiskalną | Kopia ostatniego paragonu; nie kolejna sprzedaż |
| `daily-report`: POST `/reports/daily` | RAPORT DOBOWY, zmienia liczniki | Rzeczywiste zamknięcie dnia; dodatkowo `--allow-daily-report`; nie powtarzać z nowym ID |
| `periodic-report`: POST `/reports/periodic` | DRUKUJE raport | `periodic.json`, prawdziwy zakres dat; poprawny wydruk i powrót do gotowości |
| `void-receipt`: POST `/test/void-receipt` | DRUKUJE anulowany paragon z pozycjami | `void-receipt.json`; nazwa „test” nie oznacza symulacji urządzenia |
| `break-printer-disabled`: POST `/test/break-printer` | Wyłączone w nowym brokerze | HTTP 410, brak nowej transakcji; bez `--reserve`, ale narzędzie wymaga zgody i weryfikuje wersję przed żądaniem |
| `online-receipt`: POST `/operations/receipt` | FISKALIZACJA po włączeniu | Domyślnie 503 ONLINE_DISABLED; opcjonalny kontrolowany pozytywny test z fazy 7 |
| `operation`: GET `/operations/:id` | Odczyt dziennika | `--id` znanej operacji; stan/metadane, bez USB; nieznane ID daje 404 |
| `reconcile`: POST `/operations/:id/reconcile` | Odczyt USB + dowody w dzienniku | `--id`; nie tworzy dokumentu i nie potwierdza samoczynnie `unknown` |
| `reservation-create`: POST `/printer/reservations` | Rezerwuje, bez wydruku | `operation_id`, `command`, opcjonalnie TTL; testowane w `--mode reservations` |
| `reservation`: GET `/printer/reservations/:id` | Metadane | ID/stan/ważność, bez tokenu/hasza i USB |
| `reservation-renew`: POST `/printer/reservations/:id/renew` | Odnawia niewykorzystany token | Prawidłowy token; zły 403, wygasły/zużyty nie odnawia |
| `reservation-release`: POST `/printer/reservations/:id/release` | Zwalnia niewykorzystany token | Nie przerywa przyjętego polecenia ani nie kasuje stanu `unknown` |

API raportu dobowego zachowuje dotychczasowy payload brokera: opcjonalne `cashier` i `cashRegister`. Obecny POS wysyła `register`; nazw kasjera/kasy nie należy traktować jako nowej gwarancji tego PR. Same bajty istniejących komend nie zostały zmienione.

Warianty paragonu zaawansowanego do oceny podczas uzgodnionych transakcji: gotówka, karta, płatność mieszana, BON jeśli używany, rabat na pozycji (kwota/procent), rabat na całości (kwota/procent), NIP przed zamknięciem, reszta. Każdy wariant ma osobne ID i oczekiwaną sumę. Nie trzeba tworzyć sztucznych sprzedaży tylko po to, by powtórzyć testy jednostkowe: wariant niewykonany sprzętowo oznaczyć SKIP, nie PASS. W fixture niezależnie zapisano ramki z poprzedniego `main` (bff216b), w tym tekst z polskimi znakami, rabaty, NIP, BON i raporty; testy sprawdzają identyczność bajtów i kolejności po wyłączeniu usuniętego początkowego anulowania.

## 6. Regresja rzeczywistego, obecnego POS

Zatrzymać broker i uruchomić `start-pos.cmd`: diagnostyka=false, online=false, obowiązek rezerwacji=false. Ten tryb zachowuje dotychczasowe wywołania POS. Przed otwarciem POS wykonać ponownie `npm run check:broker` i sprawdzić, że rezerwacja jest pusta, dziennik zdrowy, brak busy/blokad, a odczyty USB działają. Jeżeli pozostała niewykorzystana rezerwacja po przerwaniu testu, poczekać na jej wygaśnięcie. Dopiero wtedy otworzyć POS na tym komputerze i sprawdzić normalne połączenie z `http://localhost:3030` także w przeglądarce, nie tylko z narzędzia HTTP.

Sprawdzić przy okazji uzgodnionych rzeczywistych czynności: logowanie/wylogowanie kasjera, status/gotówkę, szufladę, sprzedaż gotówkową i kartową, NIP, rabat, płatność dzieloną, kopię, wpłatę/wypłatę oraz raporty używane w lokalu. Porównać dokument i dane rachunku; brak podwójnego rachunku lub podwójnego rozchodu. Sprzedaż przez POS zapisuje jego bazę i magazyn, w odróżnieniu od bezpośredniego testu brokera. Podmiana plików nie cofa tych danych.

Starsze wersje POS bez integracji rezerwacji nie mogą pracować z `FISCAL_REQUIRE_POS_RESERVATION=true`. Aktualny CopilotFlinkTest po PR #8 i poprawce wspólnego rejestru rezerwuje przed `createPosOrder`; operator powinien odświeżyć wszystkie karty i wykonać test według runbooka POS.

## 7. Endpoint online — opcjonalna próba w tej samej sesji

Domyślna odmowa online jest sprawdzana automatycznie. Jeśli uzgodniono również rzeczywisty test nowego endpointu, wykonać go przy **zamkniętym POS i bez odbiorcy kolejki**. Zatrzymać broker, ustawić w CMD:

```bat
set "FISCAL_DIAGNOSTICS_ONLY=false"
set "FISCAL_REQUIRE_POS_RESERVATION=true"
set "FISCAL_BRANCH_ID=1"
set "FISCAL_ENVIRONMENT=production"
set "FISCAL_ONLINE_ENABLED=true"
npm start
```

Zamrożony dokument z centralnego rejestru musi wskazywać rzeczywiście podłączone urządzenie. Uzupełniony `online-receipt.json` musi mieć to samo przypisanie i dotyczyć nowej uzgodnionej transakcji. To pojedynczy test API, bez płatności P24, rezerwacji `/pl/book`, faktury i magazynu:

```bat
npm run check:broker -- --case online-receipt --payload local-test-data\online-receipt.json --operation-id "%SESSION%:online:01" --allow-device-action --report local-results\07-online-api.json
```

Nie używać `--reserve` dla zlecenia online. Zweryfikować dokument i powtórzyć to samo ID/payload bez kolejnego wydruku. Oddział/środowisko/drukarka niezgodne z konfiguracją mają być odrzucone przed komendami fiskalnymi (pokryte automatycznie). Po próbie zatrzymać broker i wrócić do `start-pos.cmd`. To **nie jest aktywacja automatu online w lokalu**. Do niej potrzebne są centralna kolejka i nowy POS z rezerwacjami; broker odmawia online przy wyłączonym wymaganiu rezerwacji POS.

## 8. Awarie i kryteria zakończenia

- Brak USB/papieru można sprawdzić przed rozpoczęciem nowej operacji: oczekiwany brak sukcesu i brak fiskalnego wydruku. Po błędzie komunikacji uruchomić broker ponownie; nie ponawiać nieznanej operacji nowym ID.
- Podczas działania drukarki nie wywoływać celowo zaniku zasilania/USB bez odrębnej procedury. Symulacje testują przerwanie po zamknięciu, niewysłaną odpowiedź HTTP, uszkodzony dziennik i błąd fsync. Ich wynik nie jest testem sprzętowym.
- Wygaśnięcie niewykorzystanej rezerwacji nie może rozpocząć druku. Upływ TTL w trakcie polecenia, próba zwolnienia/odnowienia i drugie polecenie są pokryte automatycznie; aktywnego dokumentu nie przerywa się dla drugiego klienta.
- Po ostatniej rzeczywistej sprzedaży wykonać normalne zamknięcie dnia i raport dobowy **raz**, przez POS albo API. Porównać wynik, odczyt gotówki i liczniki. Brokera nie traktować jako źródła raportu POS: bezpośrednie dokumenty testowe/online nie są lokalnymi rachunkami POS.
- Uzupełnić `docs/regression-results-template.md` (kopię do `local-results`). Zaliczenie wymaga identyfikacji przetestowanych plików, porównania numerów z wydrukiem, braku duplikatów, sprawnych poleceń używanych przez lokal i uzgodnionego wyjaśnienia wszystkich FAIL/SKIP. Niczego nie oznaczono tu jako wykonanego na XL2.
- Nie publikować pełnych raportów z danymi nabywcy/sprzedaży. Do PR przekazać podsumowanie, firmware i zanonimizowane dowody.

## 9. Pozostawienie wersji lub powrót do poprzedniej

Po pomyślnej regresji obecnego POS można pozostawić nowy broker uruchamiany przez `start-pos.cmd`, z online wyłączonym. Nie zmieniać automatycznego startu systemowego przed zaliczeniem sesji. Uruchamianie i testy nie wykonują migracji baz, nie zmieniają strony ani kodu POS.

Rollback: zatrzymać żądania, zamknąć nowy broker, zachować dziennik i wyniki, wyjaśnić `unknown`/otwartą transakcję, potem uruchomić zachowany stary katalog dotychczasową metodą. Stara wersja nie rozumie nowego dziennika i nie wolno nią obchodzić blokady. Cofnięcie plików nie cofa wydruków, raportów, ruchów gotówki ani zapisanej sprzedaży/magazynu POS.

Pełna ścieżka dziennika jest wypisywana przy starcie (`<Electron userData>\fiscal-operations`). Po awaryjnym zakończeniu pozostawioną `operations.lock` usuwać dopiero po zatrzymaniu wszystkich instancji i sprawdzeniu PID; **nie usuwać `operations.jsonl`**. Jeśli rezerwacja przetrwała restart, poczekać na jej wygaśnięcie albo zwolnić prawidłowym tokenem. Nie kasować dziennika, aby „wyczyścić” stan.
