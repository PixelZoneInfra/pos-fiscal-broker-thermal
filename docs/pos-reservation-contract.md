# Kontrakt broker–POS: rezerwacja przed zapisem sprzedaży

API wersja 2. Integracja POS znajduje się w CopilotFlinkTest na `rozjebany2` (PR #8 i poprawka wspólnego rejestru). Aktywację rezerwacji/online wykonuje operator osobno, po wdrożeniu obu stron i odświeżeniu wszystkich kart.

Źródłem numeru jest istniejący rejestr Website `manual_invoice_registers`, zarządzany w `/admin/faktury`. Broker nie wymaga kopii numeru w ENV: porównuje cel z dokumentu z rzeczywistą tożsamością USB. Numer zwrócony w rezerwacji jest świeżym odczytem urządzenia i POS porównuje go z rejestrem przed zapisem sprzedaży.

## Stałe ID i kolejność

1. POS ustala i zachowuje jedno `operation_id` próby rozliczenia. Powinno być także kluczem idempotencji zapisu sprzedaży w backendzie POS, razem z lokalizacją. Kolejne kliknięcie/ponowienie nie tworzy nowego ID tej samej sprzedaży.
2. `POST /printer/reservations` sprawdza urządzenie i przyznaje rezerwację. Dopiero odpowiedź HTTP 201 jest zgodą na rozpoczęcie zapisu sprzedaży. Nie drukuje niczego i nie zapisuje rachunku POS.
3. POS blokuje ponowne zatwierdzenie płatności, utrzymuje rezerwację podczas zapisu `createPosOrder` i w razie potrzeby odnawia ją. Broker nie ma połączenia do bazy POS.
4. Po jednoznacznym sukcesie backendu POS klient wysyła fiskalny payload z odpowiedzi `createPosOrder`, z tym samym ID i tokenem.
5. Broker zużywa token jednorazowo, zapisuje zamiar przed komendami USB, wykonuje cały dokument i zapisuje wynik przed odpowiedzią. Samo zapisanie transakcji POS nie jest potwierdzeniem fiskalizacji.
6. Kolejne żądanie tego samego ID i payloadu zwraca wynik bez ponownego wydruku. Zmieniony payload daje `OPERATION_CONFLICT`.

**Timeout zapisu POS:** najpierw odczytać wynik backendu według stabilnego ID. Nie zakładać, że brak odpowiedzi oznacza brak zapisu i nie wykonywać ponownie `createPosOrder` bez idempotencji. Sam broker nie zapewnia atomowej transakcji pomiędzy bazą POS a drukarką. Po błędzie druku istniejący rachunek ma zachować powiązanie z ID i statusem fiskalnym do odzyskania/wyjaśnienia.

## Przyznanie

```http
POST /printer/reservations
Content-Type: application/json

{
  "operation_id": "pos:banino:unikalne-id-proby",
  "command": "receipt-advanced",
  "ttl_ms": 60000
}
```

Przykładowa odpowiedź HTTP 201:

```json
{
  "id": "reservation:uuid",
  "operation_id": "pos:banino:unikalne-id-proby",
  "command": "receipt-advanced",
  "state": "reserved",
  "expires_at": "2026-11-01T12:01:00.000Z",
  "printer_unique_number": "faktyczny-numer-z-urzadzenia",
  "token": "losowy-token-zwrocony-tylko-przy-przyznaniu"
}
```

`ttl_ms` domyślnie 60000; zakres 1000–300000 ms. `expires_at` jest datą UTC rezerwacji, nie datą dokumentu fiskalnego. Token należy do konkretnej operacji i jednego rodzaju polecenia. Broker przechowuje w dzienniku jego hash. Publiczny status nie ujawnia tokenu ani hasha. Token koordynuje urządzenie; nie zastępuje uprawnień personelu ani kontroli oddziału w centralnym API.

Komendy rezerwacji:

| `command` | Polecenie HTTP |
| --- | --- |
| `receipt` | POST `/transaction/receipt` |
| `receipt-advanced` | POST `/transaction/receipt-advanced` |
| `cashier-login` / `cashier-logout` | POST `/cashier/login` / `/cashier/logout` |
| `cash-deposit` / `cash-withdraw` | POST `/cash/deposit` / `/cash/withdraw` |
| `cash-report` | GET `/cash/report` — ten GET drukuje |
| `drawer-open` | POST `/cash-drawer/open` |
| `void-document` | POST `/transaction/void` |
| `reprint-last` | POST `/transaction/reprint-last` |
| `daily-report` / `periodic-report` | POST `/reports/daily` / `/reports/periodic` |
| `void-receipt` | POST `/test/void-receipt` |

## Wykonanie, odnowienie i zwolnienie

Polecenie otrzymuje dwa nagłówki, niezależnie od tego, czy jest POST, czy GET:

```http
X-Operation-Id: pos:banino:unikalne-id-proby
X-Printer-Reservation-Token: token-z-odpowiedzi
```

- `GET /printer/reservations/:id` — publiczny stan, bez USB i bez tokenu.
- `POST /printer/reservations/:id/renew` — nagłówek tokenu, JSON `{ "ttl_ms": 60000 }`; odnowić np. co 20 s podczas oczekiwania na backend. Błąd odnowienia musi zatrzymać przejście do nowej sprzedaży; wymaga ustalenia wyniku już rozpoczętego zapisu.
- `POST /printer/reservations/:id/release` — nagłówek tokenu, JSON `{}`. Służy porzuceniu niewykorzystanej rezerwacji, np. gdy operator anulował checkout przed zapisem albo backend jednoznacznie odrzucił sprzedaż.

Rezerwacja obejmuje jedną operację. Otwarcie szuflady po paragonie jest następnym poleceniem i w trybie wymaganym potrzebuje własnego ID i rezerwacji. Nie wolno powtórzyć sprzedaży z powodu błędu szuflady.

Podczas niewykorzystanej rezerwacji pozostałe żądania USB — także odczyty — otrzymują `PRINTER_RESERVED`. Dzięki temu odczyt statusu innej karty nie blokuje kasjera po zapisie rachunku. `/broker/status`, `/operations/:id` oraz odczyt rezerwacji pozostają dostępne bez USB. Bieżący POS musi w przyszłym PR wstrzymywać własne odpytywanie USB podczas checkoutu.

## Wygaśnięcie i restart

| Stan rezerwacji | Znaczenie |
| --- | --- |
| `reserved` | Urządzenie przydzielone; można odnowić lub zwolnić tokenem |
| `expired` | Upłynął czas niewykorzystanej rezerwacji; token nie może wykonać polecenia |
| `released` | Operator/klient zwolnił niewykorzystaną rezerwację |
| `consumed` | Token przyjęto do wykonania; wyniku szukać pod `operation_id` |

Nieprzeterminowana rezerwacja przeżywa restart i nadal wymaga oryginalnego tokenu. Utrata odpowiedzi z nowym tokenem oznacza, że klient nie ma zgody na zapis sprzedaży: czeka na wygaśnięcie, zamiast zgadywać token lub zapisywać sprzedaż.

Token jest zużywany przed odczytem kontrolnym i rozpoczęciem dokumentu. **Po przyjęciu polecenia TTL nigdy nie przerywa wydruku i nie wpuszcza drugiego klienta.** Wyłączność utrzymuje stan wykonywania, a nie zegar tokenu. Błędu `unknown` nie usuwa odnowienie, zwolnienie ani wygaśnięcie rezerwacji. Po awarii wynik pozostaje zapisany lub wymaga weryfikacji zgodnie z dziennikiem.

Jeżeli kontrola przed drukiem odrzuci operację jako `not_started`, token jest już zużyty. Po rozwiązaniu przyczyny można otrzymać nową rezerwację dla tego samego ID i identycznego payloadu. Nie tworzyć drugi raz rachunku POS, który został wcześniej zapisany. Przy `OPERATION_ALREADY_RECORDED` odczytać wynik `/operations/:id`; nowa rezerwacja nie jest potrzebna do odbioru znanego wyniku.

Rezerwacja wiąże także faktyczny numer urządzenia. Wymiana drukarki pomiędzy przyznaniem a poleceniem jest odrzucana przed wydrukiem.

## Tryby i pierwszeństwo

| Zmienna | Domyślnie | Działanie |
| --- | --- | --- |
| `FISCAL_DIAGNOSTICS_ONLY` | `false` | `true` blokuje wszystkie nowe polecenia urządzenia, także GET `/cash/report` i przyznawanie rezerwacji; odczyty pozostają |
| `FISCAL_REQUIRE_POS_RESERVATION` | `false` | `true` wymaga rezerwacji i stałego ID dla nowych poleceń POS; obecny POS bez integracji nie obsłuży tego trybu |
| `FISCAL_ONLINE_ENABLED` | `false` | Otwiera nowy endpoint online wyłącznie przy wymaganych rezerwacjach POS i pełnym przypisaniu oddział/środowisko/drukarka |
| `FISCAL_ALLOWED_ORIGINS` | puste | Opcjonalna lista dokładnych originów przeglądarkowego POS, rozdzielona przecinkami; obsługuje OPTIONS dla JSON i obu nagłówków ID/token. Bez `*` i bez końcowego `/`; nie zastępuje autoryzacji |
| `FISCAL_SERIAL_PORT` | `COM3` | Opcjonalny inny lokalny port urządzenia; szybkość i parametry pozostają 115200/8/N/1 |

Online nie tworzy rachunku POS i nie potrzebuje osobnej rezerwacji przed bazą POS: pojedyncze żądanie `/operations/receipt` obejmuje pełną wyłączność. Aktywna rezerwacja kasjera blokuje to żądanie. Rozpoczętego dokumentu online nie przerywa się dla kasjera — dostaje on `PRINTER_BUSY` i **nie powinien jeszcze zapisywać sprzedaży**. Odbiorca online ma dodatkowo ustępować aktywnemu checkoutowi po stronie aplikacji POS; broker nie widzi koszyka ani intencji kasjera przed żądaniem rezerwacji.

Kontrola rol/oddziału, centralna kolejka, stan checkoutu i idempotencja bazy POS pozostają odpowiedzialnością osobnych aplikacji. Nie aktywować automatu w lokalu na podstawie samego wdrożenia tego brokera.
