# Protokół lokalnego testu brokera — do wypełnienia

Statusy: **PASS / FAIL / SKIP** (z powodem). Puste pole nie oznacza zaliczenia. Test automatyczny i fizyczny mają osobne wyniki.

- Operator / lokal / data i godzina lokalna:
- Branch i commit pobranych plików:
- Zachowana poprzednia wersja i jej katalog / sposób uruchomienia:
- Node/npm / Windows:
- Drukarka: model / firmware / faktyczny numer unikatowy:
- COM i parametry / adres API widziany z przeglądarki POS:
- Ścieżka dziennika i wykonana kopia:
- Tryby faktycznie użyte (diagnostyka / tokeny / obecny POS / kontrolowany online):
- ID sesji / uzgodnione operacje fiskalne i kasowe:
- Liczniki i gotówka przed sesją:
- Wynik `setup-windows.cmd` / `npm test` (symulacje):

| Polecenie | Wynik fizyczny / HTTP | ID operacji i dowód / powód SKIP |
| --- | --- | --- |
| GET /broker/status | | |
| GET /status | | |
| GET /status/parsed | | |
| GET /cash/state | | |
| GET /device/diagnostics | | |
| POST /transaction/receipt | | |
| POST /transaction/receipt-advanced | | |
| POST /cashier/login | | |
| POST /cashier/logout | | |
| POST /cash/deposit | | |
| POST /cash/withdraw | | |
| GET /cash/report (drukuje) | | |
| POST /cash-drawer/open | | |
| POST /transaction/void (anulowany dokument) | | |
| POST /transaction/reprint-last (kopia niefiskalna) | | |
| POST /reports/daily (rzeczywiste zamknięcie) | | |
| POST /reports/periodic | | |
| POST /test/void-receipt (anulowany dokument z pozycjami) | | |
| POST /test/break-printer (oczekiwane 410) | | |
| POST /operations/receipt (wyłączony / kontrolowany test) | | |
| GET /operations/:id | | |
| POST /operations/:id/reconcile (dowody, bez usunięcia blokady) | | |
| POST /printer/reservations | | |
| GET /printer/reservations/:id | | |
| POST /printer/reservations/:id/renew | | |
| POST /printer/reservations/:id/release | | |

| Wariant / zabezpieczenie | Automatycznie | Na stanowisku — wynik i dowód |
| --- | --- | --- |
| Zgodność bajtów ze starym main, w tym kodowanie/framing/checksum | | |
| Gotówka / karta / mieszana / BON | | |
| NIP / rabat na pozycji / rabat na całości / reszta | | |
| Numery z wydruku vs documentNumber, dailyReceiptNumber, numer unikatowy | | |
| Identyczne ID/payload nie tworzy drugiego dokumentu | | |
| Restart po zapisanym wyniku, ponowienie tego samego ID | | |
| Rezerwacja blokuje drugi klient / odczyt USB / online | | |
| Niewykorzystana rezerwacja wygasa / zwolnienie / odnowienie | | |
| Błędny token / inny rodzaj komendy / inne ID | | |
| Upływ TTL nie przerywa rozpoczętego dokumentu | | |
| Brak papieru / USB przed operacją | | |
| Awaria po zamknięciu fiskalnym, utrata odpowiedzi HTTP | | |
| Brak fałszywego sukcesu przy błędzie lub awarii trwałego zapisu | | |
| Unknown blokuje następne polecenia również po restarcie | | |
| Tryb diagnostyczny nie dopuszcza żadnej komendy drukującej/kasowej | | |
| Rzeczywisty POS w przeglądarce: dokument, rachunek, magazyn bez duplikatów | | |

- Liczniki i gotówka po sesji / numer raportu dobowego:
- Pliki lokalnych wyników i odnośniki do zanonimizowanych dowodów:
- Wszystkie FAIL i sposób rozwiązania:
- Wszystkie SKIP i czy blokują pozostawienie wersji:
- Operacje wymagające uzgodnienia / zwrotu / ewidencji księgowej:
- Decyzja: pozostawiono nowy broker w trybie obecnego POS / wrócono do zachowanej wersji:
- Potwierdzenie: online wyłączone, brak nierozwiązanych operacji / opis blokady:

Nie publikować danych nabywców ani pełnych dzienników sprzedaży. Awarii nieprowokowanych na rzeczywistym urządzeniu nie oznaczać jako fizyczny PASS na podstawie samej symulacji.
