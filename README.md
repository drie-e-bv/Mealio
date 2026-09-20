# Mealio — Eet… geregeld

Statische webapp (React via CDN) die rechtstreeks met Supabase praat, met
Google-login en een Gemini-gedreven AI-assistent via een Supabase Edge
Function. Hosting: GitHub Pages. Geen server, geen Docker, geen NAS nodig.

## Structuur
- `index.html` — de volledige app
- `sw.js` — service worker (offline app-schil + "App installeren")
- `manifest.json`, `icon-192.png`, `icon-512.png` — PWA-iconen
- `supabase/schema.sql` — eenmalig uitvoeren in de Supabase SQL Editor
  (bevat de Row Level Security-regels met de e-mail-allowlist)
- `supabase/functions/ai-assist/index.ts` — Edge Function, deployen via
  Supabase Dashboard → Edge Functions (houdt de Gemini-sleutel geheim)
- `migrate-to-supabase.js` — eenmalig migratiescript, lokaal draaien

## Opzetten
1. Supabase-project aanmaken, `supabase/schema.sql` aanpassen (jullie
   Google-e-mailadressen invullen) en uitvoeren.
2. Google OAuth inschakelen in Supabase Authentication → Providers.
3. Edge Function `ai-assist` deployen (inhoud van
   `supabase/functions/ai-assist/index.ts`, met dezelfde twee e-mails
   ingevuld), en de secret `GEMINI_API_KEY` instellen.
4. In `index.html`: `SUPABASE_URL` en `SUPABASE_ANON_KEY` invullen.
5. Pushen naar GitHub, Pages inschakelen (Settings → Pages).

Zie het gesprek met Claude voor de volledige stap-voor-stap-uitleg.
