@echo off
rem Kopia lokalna: broker-local.cmd (nie jest wersjonowana).
rem Wpisz dokladny origin POS: protokol + host + ewentualny port, bez koncowego /.
rem Przyklad: set "FISCAL_ALLOWED_ORIGINS=https://adres-twojego-pos.example"
rem Kilka originow mozna rozdzielic przecinkami. Nie wpisuj gwiazdki.
rem Numer unikatowy jest zarzadzany tylko na stronie. Broker odczytuje go z USB.
rem Dla Banina, gdy uruchamiasz nowy POS z rezerwacjami:
rem set "FISCAL_BRANCH_ID=1"
rem set "FISCAL_ENVIRONMENT=production"
rem Opcjonalnie inny port z dzialajacej instalacji: set "FISCAL_SERIAL_PORT=COM3"
