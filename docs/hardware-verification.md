# Weryfikacja lokalna i powrót do poprzedniej wersji

Status początkowy: przygotowano kod i testy symulacyjne; **brak testu z fizyczną drukarką**. Ta procedura nie jest dowodem wykonania. Prawdziwą transakcję fiskalną, kwotę i sposób jej ujęcia należy uzgodnić przed próbą.

## Przygotowanie

1. Zapisać wersję obecnie uruchamianego brokera, lokalizację i sposób uruchomienia. Zachować działający katalog/instalator. Nie zakładać, że odpowiada bieżącemu `main`.
2. Zanotować model, firmware, numer unikatowy z urządzenia, COM i parametry połączenia. Wybrać czas bez sprzedaży POS i zamknąć jej klientów na czas podmiany. Nie uruchamiać dwóch brokerów do tego samego portu.
3. Zachować kopię istniejącego katalogu `fiscal-operations`, jeśli już występuje. Wersja testowa ma używać tego samego katalogu użytkownika przy kolejnych restartach. Nie przenosić jej pomiędzy oddziałami z tym samym dziennikiem.
4. Zainstalować zależności z lockfile, wykonać `npm test`, uruchomić testową wersję z `FISCAL_ONLINE_ENABLED` nieustawionym/`false`. Nie zmieniać produkcyjnego POS ani konfiguracji baz.

## Odczyt bez wydruku

Otworzyć `http://127.0.0.1:3030/broker/status` i `/device/diagnostics`. Oba są odczytami. Diagnostyka korzysta z `2#v`, `23#s`, `50#s`, `#c`, DLE i ENQ, nie z komend drukowania.

Zapisać odpowiedzi lokalnie i porównać:

- `identity.uniqueNumber` z faktycznym numerem fiskalnym, niezależnie od `status.uniqueId`;
- `counter.lastDocumentNumber` z ostatnim dokumentem; `receiptsSinceDailyReport` z licznikiem dobowym;
- zegar z czasem urządzenia, zakres dokładności do minuty;
- stawki VAT z konfiguracją, zwłaszcza liczby całkowite, przecinki, zwolnienie i nieaktywne sloty;
- brak otwartej transakcji i sprawność drukarki.

Zachować surowe ramki diagnostyczne, jeżeli potrzebna jest korekta parsera, bez odsyłania dodatkowych komend drukowania. Nie włączać automatu, gdy format lub znaczenie odpowiedzi różni się od specyfikacji.

## Uzgodniony test drukowania

Wykonać dopiero po osobnym uzgodnieniu transakcji i wyłączeniu normalnej sprzedaży na czas próby. Każde testowe żądanie paragonu ma stały `X-Operation-Id`. Kwota, produkt, VAT, NIP i płatność muszą odpowiadać uzgodnionej rzeczywistej operacji.

| Próba | Oczekiwany dowód |
| --- | --- |
| Paragon prosty i zaawansowany, w tym NIP/rabat/płatność używana przez POS | Wydruk, kopia i wynik `fiscal_confirmed`; zgodność sum i treści |
| Porównanie numerów | Zapisany `documentNumber` z `50#s` odpowiada dokumentowi, a licznik dobowy pozostaje osobnym polem; potwierdzony numer unikatowy |
| Powtórzenie tego samego ID | Identyczny wynik, brak kolejnego wydruku; także po zamknięciu i uruchomieniu brokera |
| Dwa równoległe żądania i raport | Jedna operacja; pozostałe HTTP 409, brak przeplatania komend |
| Odczyty i szuflada podczas drukowania | Respektują zajętość; brak zakłócenia dokumentu |
| Brak papieru / USB | Brak `success: true`; jeśli rozpoczęto operację, `unknown` i blokada następnych wydruków |
| Przerwanie po zamknięciu fiskalnym przed odpowiedzią | Po restarcie zapisany wynik albo `unknown`, bez ponownego fiskalizowania |
| Raport i operacje kasowe | Spójne wykonanie i właściwe liczniki po raporcie; nie przeprowadzać nadmiarowych raportów dobowych |

Awarii w trakcie prawdziwej fiskalizacji nie prowokować bez uzgodnionej procedury operatora/serwisu. Symulator pokrywa te scenariusze bez skutków fiskalnych. Test anulowanego paragonu nadal drukuje na rzeczywistym urządzeniu i nie zastępuje dowodu fiskalizacji.

Wyniki uzupełnić w Issue #1/PR: wersja brokera, model/firmware, daty, obserwowane formaty, porównanie dokumentu i metadanych, wyniki pozytywne/negatywne. Nie publikować danych nabywców ani pełnych dzienników sprzedaży. Brak dowodu sprzętowego pozostawia zadanie otwarte.

## Powrót do zachowanej wersji

1. Wyłączyć wszelkie nowe żądania, zatrzymać testowy broker i zachować jego logi oraz cały dziennik.
2. Jeżeli istnieje `unknown`/`in_progress`, najpierw uzgodnić faktyczny wynik na urządzeniu i w sprzedaży. Powrót do starszej wersji nie rozwiązuje nieznanej operacji; starsza wersja nie rozumie tej blokady.
3. Po uzgodnieniu wyniku uruchomić zachowany broker, z dotychczasowym portem i konfiguracją. Nie przywracać starej kopii pamięci/dziennika w celu ponowienia żądania.
4. Sprawdzić odczyt statusu i zwykłe działanie POS. Rozbieżności dokumentów wyjaśnić przed dalszą sprzedażą.

## Dalsza integracja

Po zaliczeniu testu sprzętu potrzebny jest osobny PR POS: rezerwacja drukarki przed zapisem sprzedaży, stabilne ID, obsługa `busy`/`unknown`, jeden odbiorca na stanowisku i pierwszeństwo kasjera. Dopiero potem centralna kolejka może korzystać z nowego endpointu. Kolejka, KSeF i poczta nie należą do tego wdrożenia.
