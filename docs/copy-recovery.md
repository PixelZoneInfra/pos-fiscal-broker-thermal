# Nieudana kopia ostatniego paragonu — obsługa w POS

Dotyczy wyłącznie `kind=reprintLastReceipt`, czyli komendy `1#H`. To wydruk niefiskalny. Próba nie tworzy rachunku POS, nie fiskalizuje nowej sprzedaży i nie anuluje oryginału. Nie powinna pojawiać się jako nowy, niewydrukowany rachunek.

## Błąd 115 i timeout

Specyfikacja producenta POT-I-DEV-10 v4530, s. 76–77, `th_nfbill`: kod 115 oznacza brak dostępnych danych ostatniego paragonu (np. brak paragonu w pamięci chronionej). Sam kod nie ustala, dlaczego konkretny egzemplarz/firmware nie udostępnia danych. Ponowienie `#H` nie naprawia ich braku. Parametr `Ps=1` dotyczy linii z numerem fiskalnym dobowym, nie ponownej fiskalizacji. Ta poprawka nie zmienia bajtów protokołu ani trybu wyświetlania błędów drukarki.

Drukarka może pokazać błąd na wyświetlaczu, a broker zamiast odpowiedzi otrzymać timeout. Timeout nadal oznacza `unknown`, nigdy zgodę na ponowny druk. Jeśli połączenie jest oznaczone jako niesynchronizowane, pracownik zamyka komunikat na drukarce i uruchamia broker ponownie przez istniejący VBS. Restart sam nie usuwa blokady operacji.

## Pracownik

1. W POS, również w `/staff/bills/history`, widzi alert zapisanej operacji drukarki z przyciskiem „Sprawdź operację”. Przycisk prowadzi do `/staff/fiscal-queue`.
2. Wybiera „Sprawdź stan operacji”. Broker dopisuje aktualne odczyty do dziennika; niczego nie drukuje.
3. Jeśli panel potwierdza tę samą drukarkę, zamkniętą transakcję oraz niezmienione liczniki i kwoty, wybiera „Zamknij nieudaną próbę kopii”. Broker ponownie odczytuje urządzenie pod wyłączną blokadą i trwale dopisuje decyzję z nazwą pracownika.
4. POS usuwa wyłącznie zapis tej zakończonej próby ze swojego stanowiska i wraca do `/staff`, jeśli broker nie ma innych operacji do wyjaśnienia. Żadna pozycja dziennika nie jest usuwana.

Zmiana urządzenia, przyrost liczników, otwarta transakcja, brak pełnego odczytu, inny błąd, zajętość lub błąd zapisu dziennika blokują zamknięcie. Wtedy komunikat podaje przyczynę i potrzebna jest weryfikacja kierownika. Liczniki nie dowodzą, czy kopia niefiskalna zdążyła wyjść na papierze; zamknięcie nie potwierdza jej wydrukowania i nie wysyła kolejnej kopii.

`not_started` pozwala świadomie ponowić tę samą komendę z tym samym ID, po usunięciu przyczyny i uzyskaniu nowej rezerwacji. `unknown` nie pozwala na ponowny wydruk. Po zamknięciu próby ewentualna kolejna kopia jest odrębnym świadomym poleceniem; przy 115 należy najpierw wyjaśnić dostępność danych. Rzeczywiste sprzedaże `unknown` zachowują dotychczasowe zabezpieczenia i nie można ich zamknąć przyciskiem kopii.

## API

`GET /broker/status` deklaruje `capabilities.copyRecovery=true`. `GET /operations/:id` oraz odpowiedź `reconcile` dla kopii zawierają `copyRecovery`: `can_close`, `can_retry`, `printer_error`, `reason`. Odczyt metadanych niczego nie rozstrzyga. `reconcile` pozostaje odczytem dowodów, bez automatycznego odblokowania.

```http
POST /operations/pos:copy-id/close-failed-copy
Content-Type: application/json

{
  "actor": "Pracownik Banino",
  "expected_updated_at": "wartość updatedAt z ostatniego odczytu operacji",
  "printer_unique_number": "dokładny numer przypisanej drukarki, z odstępami"
}
```

Odpowiedź: `{ "operation": { ... }, "blockedOperations": [ ... ] }`. Stan końcowy `cancelled`, `resolution.type=failed_reprint_closed`; `success` dla ponownego odczytu wyniku komendy pozostaje `false`, `retryable=false`. Nie ma fikcyjnego numeru ani potwierdzenia nowego paragonu. Ponowne zamknięcie już rozstrzygniętego ID jest idempotentnym odczytem. Endpoint nie przyjmuje rezerwacji dla nowego druku; sam respektuje aktywne rezerwacje i blokadę wykonywania.

Dla `unknown` wymagane są świeże odczyty: ta sama tożsamość USB; zamknięta transakcja w obu statusach; gotowy sprzęt; tryb fiskalny; niezmieniony numer dokumentu, licznik dobowy, licznik resetów RAM, siedem sum VAT i gotówka; brak błędu lub kod 115. Dla `not_started` nie ma skutków USB; tożsamość pochodzi z zapisanego odczytu lub zużytej rezerwacji. Inny rodzaj operacji otrzymuje `COPY_ONLY`; zmienione dane `STALE_REVIEW`; niepełny/zmieniony stan urządzenia `COPY_REVIEW_REQUIRED`.

Nowe, jednoznaczne odrzucenie `#H` kodem 115 może zostać zamknięte automatycznie przez brokera, ale tylko po takich samych świeżych odczytach i trwałym zapisie. Nadal jest wynikiem nieudanej kopii, nigdy sukcesem. Timeout, błąd USB, brak dowodów lub błąd rzeczywistej sprzedaży pozostają `unknown`.

## Wdrożenie

Najpierw broker z `main`, następnie frontend POS z `rozjebany2` i odświeżenie wszystkich kart. Bez migracji i nowych zmiennych ENV; bez zmiany konfiguracji produkcyjnej.

Przy podmianie plików zatrzymać broker przez `Zamknij.vbs`, skopiować razem `broker-service.js`, nowy `copy-recovery.js`, `api.js`, `api-catalog.js`, następnie użyć `Uruchom na nowo.vbs`. Nie podmieniać `broker-local.cmd`, nie usuwać dziennika ani `node_modules`. Pełna aktualizacja źródeł z tej wersji też jest możliwa. Stary POS nadal działa; nowy POS przy starym brokerze wyświetla konieczność aktualizacji zamiast udawać możliwość zamknięcia.

Po odblokowaniu można osobno sprawdzić druk historycznej kopii z menu pamięci chronionej zgodnie z instrukcją drukarki. Jeśli archiwum zawiera paragon, a `#H` nadal zwraca 115, potrzebna jest weryfikacja ograniczeń konkretnej wersji firmware z producentem. Nie testować przez ponowną fiskalizację sprzedaży.
