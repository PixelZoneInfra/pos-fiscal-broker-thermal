# Banino: profile Production i codzienny restart

Pakiet przygotowuje uruchomienie po zakończeniu sprzedaży. Sam merge ani
rozpakowanie kodu nie przełącza drukarki. Nie zmieniono protokołu Thermal,
kodowania, numeracji, dziennika, COM ani treści istniejących operacji.

| Etap | Uruchomienie po bezpiecznym zatrzymaniu |
| --- | --- |
| Dotychczasowa sprzedaż / rollback starego POS | `start-pos.cmd` |
| Nowy POS z rezerwacjami, online jeszcze wyłączone | `start-production-reservations.cmd` |
| POS i kolejka Production | `start-online-production.cmd` |
| Osobny fizyczny test Preview | `start-online-preview.cmd` |

Oba produkcyjne launchery po odczycie `broker-local.cmd` wymuszają oddział 1,
`production`, diagnostykę false i rezerwacje true. Tylko launcher online włącza
nowe operacje online. Zachowują port i dozwolone originy z konfiguracji lokalnej.

Po udanym starcie API wybrany profil trafia do
`local-results/broker-profile.json`. „Uruchom na nowo.vbs” odczytuje ten profil
przed zatrzymaniem procesu. Uszkodzony/nieznany profil lub brak launchera
zatrzymuje polecenie bez wyłączania działającego brokera. Brak pliku podczas
pierwszej instalacji oznacza dotychczasowy start legacy. Jawne `start-pos.cmd`
przywraca legacy i zapisuje ten wybór do następnego restartu.

Po podmianie plików pierwszy raz uruchom jawny launcher właściwego etapu;
sam stary przycisk bez zapisanego profilu pozostaje legacy. Zwykłe ręczne
uruchomienie Electron/npm bez launchera zachowuje wcześniejsze zachowanie,
ale nie wybiera nowego profilu codziennego restartu.

## Podmiana w lokalu

1. Sprawdź/oddaj wyniki Preview, także z localStorage przeglądarki. Nie zmieniaj
   środowiska zapisanego wyniku i nie usuwaj outboxa ani dziennika.
2. Zrób kopię istniejącej instalacji i konfiguracji. Zamknij broker przez
   `Zamknij.vbs`; poczekaj na brak procesu i rezerwacji. Nie wymuszaj kill.
3. Nałóż kompletny zatwierdzony kod na ten sam folder. Zachowaj
   `broker-local.cmd`, `node_modules`, `local-results` oraz katalog
   `userData/fiscal-operations`. Nie zmieniaj nazwy aplikacji ani miejsca dziennika.
4. Dokładny origin POS sprawdź w pasku przeglądarki; domyślny Banino to
   `https://pixelzonemenu-ajoc.onrender.com`. Nie wpisuj wildcard ani adresu Website.
   Zachowaj działający `FISCAL_SERIAL_PORT` (dotychczas COM3).
5. Najpierw odbierz zgodny POS w legacy, potem przejdź na rezerwacje z
   `start-production-reservations.cmd` i ustawieniem backendu
   `FISCAL_RESERVATIONS_ENABLED=true`. Przeładuj POS i sprawdź zwykłą sprzedaż.
6. Dopiero po zgodności tokenu/kontekstu, rejestru i VAT uruchom
   `start-online-production.cmd`. Online w backendzie włącz zgodnie z głównym
   runbookiem; automat początkowo false.
7. „Sprawdz stan.vbs” ma pokazać Production, oddział 1, właściwy tryb i COM.
   `npm run check:broker` jest kontrolą odczytową; nie uruchamia nowego paragonu.
8. Po pierwszym odbiorze powtórz stop/restart zwykłymi przyciskami i potwierdź,
   że wrócił dokładnie wybrany profil. Sam test kodu nie potwierdza instalacji Windows.

Rejestr Website: `f7db9b5e-bd18-4862-b38d-673c3d6be11c`, numer urządzenia
`EAO 2402426691` (litera O i spacja). Nie dodawaj drugiej kopii numeru w ENV.

Rollback: oddaj przyjęte wyniki, wyłącz nowe pobrania, bezpiecznie zatrzymaj
broker, uruchom `start-pos.cmd` i zgodny stary POS. Nie cofaj bazy ani dziennika
do kopii sprzed nowych rzeczywistych operacji.
