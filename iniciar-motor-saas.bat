@echo off
title AutoFlow SaaS - Motor WhatsApp
color 0A

echo.
echo  ======================================================
echo   AUTOFLOW SAAS - MOTOR WHATSAPP (douglaszioto@gmail.com)
echo  ======================================================
echo.

cd /d "%~dp0"

if not exist ".env.motor.local" (
    echo  Configuracao .env.motor.local nao encontrada.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  Instalando dependencias do projeto com pnpm...
    call npx pnpm install
)

if not exist "packages\config\dist\index.js" (
    echo  Compilando pacotes do projeto...
    call pnpm build
) else (
    echo  Compilando a versao atual do motor...
    call pnpm --filter ...@autoflow/whatsapp-worker build
)
if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao compilar o motor WhatsApp.
    pause
    exit /b 1
)

echo  Conectando ao banco PostgreSQL e ao WhatsApp...
echo  (Se for o primeiro acesso, o QR Code aparecera abaixo)
echo.

node --env-file=.env.motor.local apps/whatsapp-worker/dist/index.js

echo.
echo  O motor WhatsApp foi encerrado.
pause
