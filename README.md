# POSNET Thermal broker — wersja do weryfikacji

**Pierwsze uruchomienie: [START-TUTAJ.md — konkretne kroki bez edytowania plików](START-TUTAJ.md).**

Lokalny broker Electron/Express dla Posnet Thermal XL2 Online. API działa na `127.0.0.1:3030`, domyślny port drukarki pozostaje `COM3`, 115200/8/N/1. Jeśli lokalna działająca instalacja ma inny port, można go wskazać przez `FISCAL_SERIAL_PORT`, bez edycji komend. Kodowanie, komendy pozycji, rabaty, VAT i płatności zachowują dotychczasowy format.

Ta zmiana przygotowuje urządzenie do przyszłej kolejki online. Nie zawiera odbiorcy kolejki, połączeń do baz, płatności, KSeF, poczty ani operacji magazynowych. Uruchomienie wersji testowej na stanowisku wymaga przejścia [procedury sprzętowej](docs/hardware-verification.md).

**Windows: [pełny plan wdrożenia, regresji wszystkich API i powrotu do starej wersji](docs/windows-rollout-and-regression.md).** Pierwsze uruchomienie przez `start-diagnostics.cmd`; po kontroli tryb obecnego POS przez `start-pos.cmd`. Test tokenów przez `start-reservation-test.cmd` przy zamkniętym obecnym POS. [Kontrakt rezerwacji przed zapisem sprzedaży](docs/pos-reservation-contract.md) oraz [protokół wyników](docs/regression-results-template.md) są częścią pakietu.

Lokalne ustawienia przeglądarki/urządzenia można zachować w ignorowanym `broker-local.cmd` (wzór `broker-local.example.cmd`). `FISCAL_ALLOWED_ORIGINS` to dokładne originy POS, bez ścieżki i końcowego `/`, rozdzielone przecinkami. Po skonfigurowaniu dozwolony POS otrzymuje CORS/OPTIONS dla JSON oraz nagłówków ID/token; obcy origin jest odrzucany przed komendami. Bez konfiguracji zachowano poprzednie zachowanie HTTP bez CORS. Ten parametr nie zmienia kodowania ani komend urządzenia.

## Uruchomienie i testy

```sh
npm ci
npm test
npm start
```

Testy używają `node:test`, prawdziwego API HTTP i symulowanego portu; nie importują Electron/SerialPort i niczego nie drukują. CI uruchamia je na Node 20 w Windows i Linux, z `npm ci --ignore-scripts` (testy nie wymagają binariów Electron ani natywnego portu).

## Wyłączność i wynik

Wszystkie ścieżki HTTP korzystają z jednego `BrokerService`. Blokada obejmuje sprawdzenie urządzenia, zapis zamiaru, cały dokument/raport i odczyt wyniku. Równoległe żądanie dostaje `409 PRINTER_BUSY`, bez wysyłania komend i bez wewnętrznej kolejki. Broker udostępnia też trwałą rezerwację przed zapisem sprzedaży; aktywny token kasjera blokuje inne polecenia i odczyty USB (`PRINTER_RESERVED`). Obsługa checkoutu, odnowień i idempotencji zapisu bazy POS wymaga osobnego PR w POS.

Przed operacją broker sprawdza stan sprzętu, otwartą transakcję i faktyczny numer urządzenia. Nie anuluje zastanej transakcji. Każda komenda zmieniająca stan wymaga odczytu ENQ/CMD i DLE; zapis do USB sam nie oznacza sukcesu. Raporty zachowują blokadę podczas oczekiwania, z limitem 120 s zamiast 5 s. Timeout zatrzymuje operację; nie świadczy o jej niewykonaniu.

| Stan | Znaczenie | Powtórzenie tego samego ID |
| --- | --- | --- |
| `not_started` | Nie wysłano komend zmieniających stan | Może ponowić sprawdzenie i próbę, jeśli dziennik i połączenie są sprawne |
| `in_progress` | Zamiar zapisany trwale; urządzenie mogło rozpocząć operację | Zwraca stan; nie drukuje ponownie |
| `fiscal_confirmed` | Zakończenie i przyrost liczników potwierdzone, wynik zapisany trwale | Zwraca zapisany wynik, również po restarcie |
| `completed` | Potwierdzona operacja inna niż fiskalny paragon | Zwraca zapisany wynik |
| `unknown` | Operacja mogła się wykonać; potrzebna weryfikacja | Zwraca brak potwierdzenia; blokuje wszystkie nowe operacje zmieniające stan |
| `not_fiscalized` | Operator ustalił brak fiskalizacji i zamknął transakcję | Wynik końcowy; brak automatycznego ponowienia |

Ten sam identyfikator z inną treścią daje `409 OPERATION_CONFLICT`. Potwierdzony paragon wymaga fiskalnego TRF, braku otwartej transakcji, tej samej drukarki oraz przyrostu numeru dokumentu i licznika dobowego dokładnie o jeden. Błąd po fiskalnym zamknięciu, np. podczas stopki, daje `unknown`, z zachowanym potwierdzeniem części fiskalnej.

## Zgodność obecnego POS

Dotychczasowe ścieżki i podstawowe pola odpowiedzi pozostają, m.in. `success`, `message`, `total`. `success: true` dla paragonu oznacza teraz potwierdzenie, a nie samo wysłanie komend. Błędy zawierają `state`, `operation_id`, `retryable`; zajętość i konieczność weryfikacji dają HTTP 409, awaria wykonania 503. Zamierzony endpoint `/test/break-printer` jest wyłączony (410), ponieważ zostawiał otwartą transakcję.

Oba endpointy paragonów przyjmują opcjonalny nagłówek `X-Operation-Id`. POS powinien przechowywać stabilne ID próby i używać go ponownie po utracie odpowiedzi. Bez nagłówka broker tworzy `local:<UUID>` i chroni przebieg, ale nie potrafi rozpoznać dwóch osobnych żądań jako tej samej sprzedaży. Nie wolno dodawać automatycznych ponowień starego klienta bez stabilnego ID.

`GET /status/parsed` zachowuje nazwy pól, ale używa stałych siedmiu slotów VAT (`th_scinfo Ps=23`). `uniqueId` jest nadal identyfikatorem programowanym i **nie jest numerem unikatowym fiskalnym**. Rzeczywisty numer zwraca `/device/diagnostics` w `identity.uniqueNumber`.

## Dodatkowe API

| Ścieżka | Działanie |
| --- | --- |
| `GET /broker/status` | Zajętość, blokady dziennika i przypisanie stanowiska, bez USB |
| `GET /device/diagnostics` | Odczyt urządzenia, bez drukowania; respektuje wyłączność |
| `GET /operations/:id` | Trwały zapis operacji, bez USB |
| `POST /operations/:id/reconcile` | Dodatkowy odczyt dowodów; nie zmienia `unknown` na sukces |
| `POST /operations/receipt` | Nowy kontrakt zlecenia, domyślnie wyłączony |
| `POST /printer/reservations` | Sprawdza gotowość i rezerwuje dla ID/rodzaju polecenia, bez wydruku |
| `GET /printer/reservations/:id` | Publiczny stan bez tokenu i bez USB |
| `POST /printer/reservations/:id/renew` | Odnawia niewykorzystany token |
| `POST /printer/reservations/:id/release` | Zwalnia niewykorzystany token; nie usuwa `unknown` |

Przyszłe stanowisko online wymaga lokalnej, stałej konfiguracji:

```text
FISCAL_ONLINE_ENABLED=true
FISCAL_REQUIRE_POS_RESERVATION=true
FISCAL_BRANCH_ID=1
FISCAL_ENVIRONMENT=production
FISCAL_PRINTER_UNIQUE_NUMBER=<faktyczny numer z th_getrealid>
```

Wartości powyżej są opisem konfiguracji, nie instrukcją włączenia produkcji. Nie włączać odbiorcy online przed testem sprzętu i wdrożeniem rezerwacji urządzenia **przed `createPosOrder`** w POS. Odczyt `/broker/status` nie jest rezerwacją i nie usuwa wyścigu między sprawdzeniem zajętości a sprzedażą.

`FISCAL_DIAGNOSTICS_ONLY=true` blokuje nowe komendy urządzenia i przyznawanie tokenów, pozostawiając odczyty. `FISCAL_REQUIRE_POS_RESERVATION=false` (domyślnie) zachowuje dotychczasowego klienta. `true` wymaga nagłówków `X-Operation-Id` i `X-Printer-Reservation-Token` przy wszystkich nowych poleceniach POS, w tym raportach i szufladzie. `/operations/receipt` odmawia działania online, jeśli obowiązek tokenów POS jest wyłączony. Te flagi nie zmieniają kodowania ani budowy komend Thermal.

`npm run check:broker` domyślnie wykonuje wyłącznie pięć odczytów; `--mode reservations` sprawdza tokeny bez druku. Indywidualne polecenia urządzenia wymagają `--case`, stałego `--operation-id`, `--allow-device-action` i odpowiednich danych; raport dobowy dodatkowo `--allow-daily-report`. Narzędzie nie ponawia żądań automatycznie. Szczegóły i wszystkie przykłady są w planie Windows. Wyniki w `local-results` i rzeczywiste payloady w `local-test-data` są ignorowane przez Git.

Żądanie (bez danych adresowych i e-mail do faktury):

```json
{
  "operation_id": "online:payment-unique-id",
  "branch_id": 1,
  "environment": "production",
  "printer_unique_number": "ABC1234567890",
  "receipt": {
    "items": [{ "name": "Bilet", "quantity": 1, "unitPrice": 50, "vatRate": "B" }],
    "payments": [{ "type": "CARD", "amount": 50, "name": "PayU" }]
  }
}
```

API wymaga zgodności oddziału, środowiska i drukarki z konfiguracją lokalną. Przed wydrukiem porównuje też faktyczne ID odczytane przez USB. Przykładowa stawka VAT nie określa właściwej stawki dla produktu.

## Dziennik i odzyskiwanie

Dziennik `operations.jsonl` leży w `<Electron userData>/fiscal-operations`, poza repozytorium i katalogiem instalacji. Pełna ścieżka jest wypisywana przy starcie. Zawiera kolejne stany i łańcuch sum SHA-256 wykrywający przypadkowe uszkodzenie. Każdy zapis jest synchronizowany na dysk przed kontynuacją. Sumy nie zastępują kontroli dostępu do komputera. Nie usuwać ani nie skracać dziennika przy aktualizacji.

Po restarcie zapisane `in_progress` zmienia się na `unknown`. Potwierdzony wynik pozostaje dostępny, bez drukowania. Uszkodzony, niepełny lub niezapisywalny dziennik blokuje pracę. Po timeout, błędzie lub nieoczekiwanej odpowiedzi połączenie jest uznawane za niezsynchronizowane i wymaga ponownego uruchomienia; późna odpowiedź nie może zostać przypisana nowemu żądaniu.

Electron blokuje drugą instancję. Dodatkowa blokada dziennika zabezpiecza narzędzie operatora. Po awaryjnym zakończeniu może pozostać `operations.lock`: zatrzymać wszystkie instancje, sprawdzić zapisany PID i potwierdzić, że proces już nie działa; wtedy usunąć **wyłącznie plik blokady**, zachowując dziennik. Broker celowo nie usuwa takiej blokady automatycznie. Restart ani odczyt TRF nie stanowią zgody na ponowny wydruk.

Weryfikacja `unknown` wymaga porównania kopii/dokumentów urządzenia ze sprzedażą i zapisanymi licznikami. Przy otwartej transakcji potrzebne jest jej świadome zamknięcie na urządzeniu zgodnie z procedurą operatora/serwisu. Nowy paragon i raport dobowy nie służą do „wyczyszczenia” błędu. Po zebraniu dowodów zamknąć Electron i użyć lokalnego narzędzia, np. dla potwierdzonego paragonu:

```sh
npm run review -- --directory "<pełna ścieżka>/fiscal-operations" --id "online:payment-unique-id" --decision fiscal_confirmed --actor "Operator" --evidence "Numer kopii i opis porównania" --document "101" --printer "ABC1234567890" --date "2026-11-01" --device-closed
```

Narzędzie nie łączy się z drukarką i nie może samodzielnie sprawdzić dowodów. Zapisuje decyzję operatora w dzienniku; wymaga numeru tej samej drukarki. `not_fiscalized` służy wyłącznie ustalonemu brakowi fiskalizacji, a `completed` operacjom innym niż sprzedaż. Zakończonego ID nie wykonuje ponownie; ewentualne nowe zlecenie wymaga osobnej świadomej decyzji po uzgodnieniu wyniku.

## Źródło kontraktu urządzenia

Specyfikacja producenta **POT-I-DEV-10, wersja 4530, 6.09.2019**:

- s. 11–13: ENQ, DLE, TRF w pamięci nieulotnej, ramki i suma kontrolna;
- s. 69–71: `th_scinfo Ps=23` — stałe sloty VAT i licznik od raportu dobowego;
- s. 72–73: `th_scnt` (`50#s`) — numer ostatnio wydrukowanego dokumentu;
- s. 75–76: `th_getrealid` (`2#v`) — faktyczny typ, firmware i numer unikatowy;
- s. 69: `th_rtcget` — czas lokalny zegara, z dokładnością do minuty.

`receipt.documentNumber` i `dailyReceiptNumber` pozostają oddzielne. `printerClockBefore` i `printerClockAfter` są obserwacjami zegara, nie dokładną datą/czasem wydrukowanego paragonu. Nie generujemy fikcyjnego czasu fiskalizacji ani strefy UTC. Znaczenie numerów i zakres odczytu daty trzeba porównać z fizycznym dokumentem przed integracją faktur.
