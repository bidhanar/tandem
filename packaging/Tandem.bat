@echo off
rem Starts Tandem. Keep this window open while you use it; close it to quit.
title Tandem
cd /d "%~dp0"
runtime\node.exe app\local\dist\src\main.js %*
if errorlevel 1 pause
