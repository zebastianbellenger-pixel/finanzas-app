@echo off
rem Creates the "Mis Finanzas" shortcut on the Desktop. Double-click once per computer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
pause
