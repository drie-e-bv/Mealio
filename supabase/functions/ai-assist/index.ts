// Mealio — Edge Function "ai-assist"
// Houdt de Gemini-sleutel geheim (staat als secret op Supabase, nooit in de
// site zelf). Twee taken, aangeroepen met { task: 'plan_week' | ... }.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function
// (naam: ai-assist) → deze inhoud plakken → Deploy.
// Secret zetten: Project Settings → Edge Functions → Secrets →
//   GEMINI_API_KEY = <je gratis sleutel van aistudio.google.com/apikey>
//   GEMINI_MODEL   = gemini-flash-latest   (optioneel, dit is de default)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// >>> VERVANG door dezelfde twee e-mailadressen als in supabase/schema.sql <<<
const ALLOWED_EMAILS = ['bral.ampe@gmail.com', 'peter@casentis.be'];

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function buildPrompt(body) {
  if (body.task === 'plan_week') {
    return `Je bent een maaltijdplanner-assistent voor een koolhydraatarm huishouden.
Kies voor elk leeg maaltijdslot hieronder een geschikt recept uit de receptenlijst.
Regels:
- Het recept moet dezelfde categorie hebben als het opgegeven type van het slot.
- Sterren geven aan hoe graag het huishouden een recept eet: 5 sterren mag zelfs
  wekelijks terugkomen, 4 sterren regelmatig, 3 af en toe, 2 zelden, 1 ster
  hooguit 1x per maand. Recepten zonder sterren: gebruik spaarzaam.
- RECENT_GEKOZEN bevat titels die de voorbije weken al gepland zijn — vermijd
  die te herhalen, zeker bij recepten met weinig sterren.
- Zorg voor variatie doorheen de week (niet elke dag hetzelfde type eiwit/gerecht).
- Gebruik uitsluitend recipeId-waarden die letterlijk in RECEPTEN voorkomen.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"assignments":[{"day":"Maandag","meal":"Avond","recipeId":"..."}]}

SLOTS: ${JSON.stringify(body.slots || [])}
RECEPTEN: ${JSON.stringify(body.recipes || [])}
RECENT_GEKOZEN: ${JSON.stringify(body.recentTitles || [])}`;
  }
  if (body.task === 'suggest_recipes') {
    const count = Number(body.count) || 2;
    return `Je bent een receptenbedenker voor een koolhydraatarm huishouden.
Bedenk ${count} nieuw(e) recept(en) die vooral gebruikmaken van de ingrediënten in
VOORRAAD hieronder. Een paar gangbare basisingrediënten toevoegen (kruiden, olie,
zout, peper) mag, maar het merendeel van elk recept moet uit VOORRAAD komen.
Hoeveelheden zijn per 1 persoon. Categorie is één van: Hoofdmaaltijd, Salade,
Ontbijt, Snack, Dessert, Extra.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"suggestions":[{"title":"...","category":"Hoofdmaaltijd","basePortions":1,
"ingredients":[{"name":"...","amount":100,"unit":"g"}],"steps":["...","..."]}]}

VOORRAAD: ${JSON.stringify(body.pantryItems || [])}`;
  }
  throw new Error('Onbekende task: ' + body.task);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Wie roept dit aan? verify_jwt (standaard aan) garandeert al dat er
    // geldig ingelogd is; hier controleren we ook nog het e-mail-allowlist,
    // net als in de RLS-regels op de database.
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
    );
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user || !ALLOWED_EMAILS.includes(user.email)) {
      return json({ error: 'Niet toegelaten' }, 403);
    }
    if (!GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY ontbreekt als secret op deze function' }, 500);

    const body = await req.json();
    const prompt = buildPrompt(body);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini-fout (${geminiRes.status}): ${errText.slice(0, 300)}`);
    }
    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Geen antwoord van Gemini ontvangen');

    return json(JSON.parse(text));
  } catch (e) {
    return json({ error: e.message || 'Onbekende fout' }, 500);
  }
});
