# Start na komputerze z drukarką — bez edytowania plików

**Codzienna obsługa v2:** kliknij `Uruchom na nowo.vbs`, stan sprawdzaj przez `Sprawdz stan.vbs`, a pracę kończ przez `Zamknij.vbs`. Na pulpit utwórz skróty do tych plików; oryginały i `tools` zostają w katalogu brokera. Nie pojawia się okno CMD ani strona `index.html`. [Krótka instrukcja](tools/INSTALACJA.txt).

Poniższe kroki dotyczą pierwszego przygotowania i diagnostyki instalacji. Na początek robimy odczyt drukarki i test rezerwacji bez drukowania. Potem sprawdzamy obecny POS tak, jak używasz go codziennie. Dokumentacja w `docs` zawiera dodatkowe testy API; nie jest listą rzeczy, które trzeba konfigurować przed pierwszym uruchomieniem.

1. Pobierz cały ZIP brancha `feature/windows-background-controls-v2-20261101` i rozpakuj do NOWEGO folderu. Stary działający folder zachowaj bez zmian.
2. Otwórz rozpakowany folder do poziomu, na którym widać `package.json`, `setup-windows.cmd` i `start-diagnostics.cmd`.
3. Kliknij pasek adresu Eksploratora plików, wpisz `cmd` i naciśnij Enter. Otworzy się czarne okno już w odpowiednim folderze.
4. Wpisz `setup-windows.cmd` i Enter. Poczekaj na koniec instalacji/testów i tekst `Przygotowanie zakonczone. Broker NIE zostal uruchomiony.` Jeśli jest błąd, zatrzymaj się i zachowaj komunikat. Nie otwieraj kolejnych trybów.
5. Zamknij wszystkie okna/karty POS i okno starego brokera. Drukarka ma być włączona i podłączona tym samym USB jak zwykle.
6. W tym samym czarnym oknie wpisz `start-diagnostics.cmd`. Broker uruchomi się w tle, bez okna index.html. Zostaw CMD otwarte do podglądu komunikatów.
7. Otwórz DRUGIE CMD przez pasek adresu tego samego folderu. Wpisz `npm run check:broker`. Nic nie ma się wydrukować. Po sukcesie pojawi się `Odczyty/odpowiedzi HTTP zgodne...` i nazwa pliku wyniku. Przy `STOP` zatrzymaj test i zachowaj wynik.
8. Kliknij `Zamknij.vbs` i poczekaj na potwierdzenie. W pierwszym CMD wpisz `start-reservation-test.cmd`; potem w drugim wpisz `npm run check:broker -- --mode reservations`. To również nie drukuje. Po sukcesie zatrzymaj broker przez `Zamknij.vbs`.
9. Do testu przez stronę POS potrzebny jest jej adres. Otwórz stronę swojego POS, lecz nie wykonuj sprzedaży. Naciśnij Ctrl+L i Ctrl+C, aby skopiować cały adres. W drugim CMD wpisz `configure-pos.cmd`, wklej adres (Ctrl+V) i Enter. Po `Gotowe` zamknij kartę POS. Kreator sam zapisuje potrzebne ustawienie — niczego nie edytujesz.
10. W pierwszym CMD wpisz `start-pos.cmd`. W drugim wykonaj jeszcze raz `npm run check:broker`. Po sukcesie otwórz POS i używaj zwykłych przycisków: status/stan gotówki, szuflada, logowanie kasjera, uzgodniona nowa sprzedaż gotówką/kartą, rabat/NIP jeśli dotyczą tej sprzedaży, kopia oraz operacje kasowe i raporty używane w lokalu. Te czynności są RZECZYWISTE. Nie powtarzaj sprzedaży po błędzie, zanim nie ustalisz, czy paragon powstał. Raport dobowy wykonaj raz, przy normalnym zamknięciu dnia.

Nie uruchamiaj na raz dwóch brokerów. Nie wpisuj flag online ani nie przygotowuj JSON-ów do tego pierwszego sprawdzenia. Domyślny port jest nadal COM3; jeśli działający lokalny broker ma inny COM, ustalimy go z wyniku diagnostyki, zanim zaczniemy drukować.

Powrót: zatrzymaj nowy broker przez `Zamknij.vbs` i dopiero po potwierdzeniu uruchom zachowany stary folder swoją dotychczasową metodą. Jeżeli wystąpił błąd podczas drukowania albo nie wiadomo, czy paragon powstał, najpierw wyjaśnij wynik; cofnięcie plików nie cofa dokumentów ani sprzedaży POS.

Wyniki odczytów są automatycznie zapisywane w `local-results`. Pełna macierz 26 API, nowe API online i procedury awaryjne są w [dokumencie technicznym](docs/windows-rollout-and-regression.md); bezpośrednie testy fiskalne API są osobnym, uzgodnionym zakresem, a nie warunkiem odczytu urządzenia.
