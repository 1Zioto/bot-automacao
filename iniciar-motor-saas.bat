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

if not exist "apps\whatsapp-worker\dist\index.js" (
    echo  Compilando arquivos TypeScript do projeto...
    call npx pnpm build
)

echo  Conectando ao banco PostgreSQL (Neon)...
echo  Aguarde a geracao do QR Code abaixo...
echo.

node --env-file=.env.motor.local apps/whatsapp-worker/dist/index.js

echo.
echo  O motor WhatsApp foi encerrado.
pause
