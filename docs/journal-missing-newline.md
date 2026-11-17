# Start zatrzymany: „Niepełny dziennik”

Ten konkretny komunikat `OperationJournal` oznacza, że niepusty `operations.jsonl` nie kończy się bajtem LF (`0A`). Nie przesądza, czy brakuje tylko nowej linii (np. po zapisaniu pliku edytorem), czy końcowy wpis jest urwany. To odrębna sytuacja od osieroconego PID i od operacji `unknown`: same `unknown` nie blokują uruchomienia API.

## Naprawa bez usuwania historii

Narzędzie `tools/repair-journal-newline.js` korzysta z istniejącego `operation-journal.js`, `tools/recover-journal-lock.js` i `package.json`. Do aktualnej instalacji wystarczy dodać ten jeden nowy plik w `tools`; bez podmiany całego brokera, nowych ENV, npm install i migracji.

Zamknąć broker zwykłym przyciskiem. W PowerShell/CMD w katalogu instalacji:

```powershell
node .\tools\repair-journal-newline.js
```

To wyłącznie odczyt dziennika z `%APPDATA%\pos-fiscal-broker-thermal\fiscal-operations\operations.jsonl`. Sprawdza UTF-8, JSON wszystkich wpisów, kolejne numery sekwencji oraz cały łańcuch SHA-256 tą samą funkcją co broker. Nie tworzy blokad ani kopii i niczego nie drukuje.

Jeżeli brakuje tylko końcowej nowej linii:

```powershell
node .\tools\repair-journal-newline.js --repair
```

Naprawa sprawdza brak API na 3030 i procesów mogących używać brokera. Uzyskuje tę samą wyłączną `operations.lock`, której używa broker i narzędzie operatora. Istniejącej blokady nie usuwa; w takim przypadku najpierw użyć istniejącego `Odzyskaj po awarii.vbs` zgodnie z jego kontrolą PID/procesów.

Po sprawdzeniu wszystkich wpisów tworzy osobny katalog `journal-newline-backups` obok dziennika, z dokładną kopią oryginalnych bajtów i metadanymi naprawy. Powtarza kontrolę procesów i zgodności pliku, a następnie dopisuje **wyłącznie jeden bajt LF** i wykonuje `fsync`. Nie przekodowuje JSON, nie usuwa ani nie zmienia wpisów, nie przebudowuje sum i nie rozstrzyga `unknown`/`in_progress`. Po potwierdzeniu zapisuje `completed.json` w kopii. Drugi przebieg na poprawnym pliku niczego nie zmienia.

Przy urwanym JSON, zmienionej sumie, brakującym wpisie w środku łańcucha, nieprawidłowym kodowaniu, zajętości urządzenia, zmianie pliku lub problemie z kopią odmawia dopisania. Trzeba wtedy porównać dziennik z kopiami i rzeczywistymi dokumentami; nie skracać automatycznie pliku ani nie odtwarzać go jako pustego. Narzędzie potwierdza spójność obecnych wpisów; nie potrafi wykryć, że ktoś wcześniej usunął cały poprawny końcowy fragment, ani odtworzyć takich danych.

Po komunikacie `NAPRAWIONO` uruchomić dotychczasowy profil brokera (dla obecnego produkcyjnego Banina `start-online-production.cmd` lub zapisany VBS). Dopiero po działającym API obsłużyć zapisaną nieudaną kopię przez panel POS `/staff/fiscal-queue`. Naprawa formatu nie odblokowuje sama nieznanego wyniku wydruku i nie ponawia sprzedaży.

Testy obejmują dokładnie jednobajtową zmianę, zachowanie stanów i numerów, kopię oryginału, ponowny start, kontrolę odczytu CLI, odmowę dla urwanego/zmodyfikowanego łańcucha i kodowania UTF-16/BOM, aktywną blokadę/procesy, zmianę pliku po kopii, błędy kopii oraz wielokrotne dowiązania. Nie zmienia się zachowania startu brokera ani starego skryptu odzyskiwania blokady.
