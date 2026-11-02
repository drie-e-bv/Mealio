// Mealio — Edge Function "ai-assist"
// Houdt de Gemini-sleutel geheim (staat als secret op Supabase, nooit in de
// site zelf). Taken, aangeroepen met { task: '...' }:
//   plan_week     - vult open maaltijden in (volledig recept of samengesteld bord)
//   restjes_idea  - idee om restjes tot een maaltijd te combineren
//   suggest_recipes - bedenkt recepten op basis van je kastvoorraad
//   import_url    - haalt een recept op van een URL en zet het om naar
//                    Mealio's formaat (eerst gratis via Schema.org-data op
//                    de pagina zelf, pas als dat niets oplevert via Gemini)
//   import_photo  - leest een recept uit een foto, screenshot(s) of PDF
//                    ({ files: [{data, mimeType}] }, max 5; oud formaat
//                    { imageBase64, mimeType } blijft werken) via Gemini
//   scan_pantry   - herkent voedingsmiddelen op een foto van koelkast/kast
//
// Toegang: wie mag, staat in de tabel allowed_emails (beheerbaar in de app);
// deze function vraagt dat na via de databasefunctie is_allowed_user().
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function
// (naam: ai-assist) → deze inhoud plakken → Deploy.
// Secret zetten: Project Settings → Edge Functions → Secrets →
//   GEMINI_API_KEY = <je gratis sleutel van aistudio.google.com/apikey>
//   GEMINI_MODEL   = gemini-flash-latest   (optioneel, dit is de default)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
Vul elk slot in SLOTS in met recepten uit RECEPTEN.

Twee soorten slots:
1. type = een receptcategorie (bv. "Hoofdmaaltijd", "Ontbijt"): kies precies één
   recept met exact die categorie -> geef "recipeId".
2. type = "Samenstellen": stel een bord samen uit losse onderdelen -> geef
   "componentIds" (lijst):
   - precies één recept met categorie "Eiwit" (vlees, vis of veggie),
   - precies één recept met categorie "Groenten",
   - optioneel één "Bijgerecht" (niet elke dag — het huishouden eet koolhydraatarm),
   - optioneel één "Saus" als die past.
   Heeft een slot een lijst "keep", neem die ids dan letterlijk over in
   componentIds en vul enkel de ontbrekende onderdelen aan.
   Bestaat een categorie niet in RECEPTEN, sla dat onderdeel dan over.

Regels:
- Sterren = hoe graag het huishouden het eet: 5 mag wekelijks terugkomen,
  4 regelmatig, 3 af en toe, 2 zelden, 1 hooguit 1x per maand.
  Recepten zonder sterren: af en toe, om nieuwe dingen te proberen.
- HISTORIEK toont wat de voorbije weken al gegeten werd (weeksAgo = hoeveel
  weken geleden, 0 = deze week al vast gepland). Respecteer de sterrenregel
  hierboven t.o.v. die historiek.
- Zorg voor variatie binnen de week: niet twee dagen na elkaar hetzelfde eiwit
  of dezelfde groente, en niet twee keer hetzelfde gerecht in één week.
- Gebruik uitsluitend id-waarden die letterlijk in RECEPTEN voorkomen.
- VOORKEUREN van gezinsleden: een recept met een niet-lege lijst "dislikedBy"
  bevat iets wat iemand niet lust. Kies zo'n recept liefst NIET; enkel als er
  echt geen alternatief in die categorie is. Kies NOOIT een recept dat iets uit
  ALLERGIEEN bevat.

Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"assignments":[{"day":"Maandag","meal":"Avond","recipeId":"..."},{"day":"Dinsdag","meal":"Avond","componentIds":["...","..."]}]}

SLOTS: ${JSON.stringify(body.slots || [])}
RECEPTEN: ${JSON.stringify(body.recipes || [])}
HISTORIEK: ${JSON.stringify(body.recentHistory || [])}
ALLERGIEEN: ${JSON.stringify(body.allergies || [])}
LUST NIET: ${JSON.stringify(body.avoid || [])}`;
  }
  if (body.task === 'suggest_recipes') {
    const count = Number(body.count) || 2;
    return `Je bent een receptenbedenker voor een koolhydraatarm huishouden.
Bedenk ${count} nieuw(e) recept(en) die vooral gebruikmaken van de ingrediënten in
VOORRAAD hieronder. Een paar gangbare basisingrediënten toevoegen (kruiden, olie,
zout, peper) mag, maar het merendeel van elk recept moet uit VOORRAAD komen.
Hoeveelheden zijn per 1 persoon. Categorie is één van: Hoofdmaaltijd, Salade,
Ontbijt, Snack, Dessert, Extra (volledige gerechten) of Eiwit, Groenten,
Bijgerecht, Saus (onderdelen van een samengesteld bord).
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"suggestions":[{"title":"...","category":"Hoofdmaaltijd","basePortions":1,
"ingredients":[{"name":"...","amount":100,"unit":"g"}],"steps":["...","..."]}]}

VOORRAAD: ${JSON.stringify(body.pantryItems || [])}`;
  }
  if (body.task === 'restjes_idea') {
    return `Je krijgt een lijstje restjes/ingrediënten die iemand nog over heeft van
eerdere maaltijden, voor een koolhydraatarm huishouden. Geef een kort, praktisch
idee (2-4 zinnen, geen volledig stappenplan) hoe ze dit tot een volwaardige
maaltijd combineren — een paar gangbare aanvullingen (ei, kruiden, olie, een
groente) mogen erbij als dat logisch is.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"title":"korte naam voor het gerecht","idea":"praktisch idee in 2-4 zinnen"}

RESTJES: ${JSON.stringify(body.ingredients || [])}`;
  }
  throw new Error('Onbekende task: ' + body.task);
}

async function callGeminiParts(parts) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY ontbreekt als secret op deze function');

  // Gemini geeft af en toe kortstondig 503 (te druk) of 429 (rate limit) terug
  // op het gratis niveau — dat lost meestal vanzelf op binnen enkele seconden,
  // dus we proberen het automatisch een paar keer opnieuw i.p.v. meteen te falen.
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Geen antwoord van Gemini ontvangen');
      return JSON.parse(text);
    }
    const errText = await res.text();
    lastError = new Error(`Gemini-fout (${res.status}): ${errText.slice(0, 300)}`);
    if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, attempt * 1500)); // 1.5s, dan 3s
      continue;
    }
    throw lastError;
  }
  throw lastError;
}
function callGemini(prompt) { return callGeminiParts([{ text: prompt }]); }
function callGeminiVision(prompt, base64, mimeType) {
  return callGeminiParts([{ text: prompt }, { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } }]);
}

function importPhotoPrompt() {
  return `Je krijgt één of meer bestanden met samen één recept: een foto (receptenkaart,
kookboekpagina, tijdschriftknipsel, handgeschreven notitie), screenshots (bv. van een
website, Instagram of een app) of een PDF. Meerdere bestanden horen bij hetzelfde recept
(bv. ingrediënten op het ene, bereiding op het andere). Staan er meerdere recepten in,
neem dan het belangrijkste/eerste. Negeer reclame, menu's, knoppen en commentaren.
Lees de tekst en zet het recept om naar Mealio's formaat, in het Nederlands.
Categorie is één van: Hoofdmaaltijd, Salade, Ontbijt, Snack, Dessert, Extra
(volledige gerechten) of Eiwit, Groenten, Bijgerecht, Saus (als het duidelijk maar
één onderdeel van een bord is).
basePortions is het aantal porties dat vermeld staat (schat 2 als niets vermeld staat).
Ingrediënten met een duidelijke hoeveelheid en eenheid waar mogelijk; anders amount
null en de vrije tekst in unit.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"title":"...","category":"Hoofdmaaltijd","basePortions":2,
"ingredients":[{"name":"...","amount":300,"unit":"g"}],"steps":["...","..."]}`;
}

function scanPantryPrompt() {
  return `Je krijgt een foto van de binnenkant van een koelkast, voorraadkast of
diepvries. Benoem de voedingsmiddelen die je duidelijk herkent, in het Nederlands
(Vlaams), kort en algemeen zoals op een boodschappenlijst: bv. "eieren", "melk",
"kipfilet", "paprika", "griekse yoghurt", "passata". Geen merknamen, geen
hoeveelheden, geen dubbels, geen niet-eetbare dingen. Twijfel je, laat het weg.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"items":["eieren","melk"]}`;
}

// --- Recept van een URL: eerst gratis Schema.org-data proberen ---
function extractSchemaRecipe(html) {
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const candidates = [];
    (function collect(node) {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (typeof node !== 'object') return;
      const type = node['@type'];
      if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) candidates.push(node);
      if (node['@graph']) collect(node['@graph']);
    })(data);
    if (candidates.length) {
      const r = candidates[0];
      const title = (r.name || '').toString().trim();
      let portions = 1;
      if (r.recipeYield) {
        const s = Array.isArray(r.recipeYield) ? r.recipeYield.join(' ') : String(r.recipeYield);
        const nm = s.match(/\d+/);
        if (nm) portions = parseInt(nm[0], 10) || 1;
      }
      const ingredientLines = Array.isArray(r.recipeIngredient) ? r.recipeIngredient : [];
      let steps = [];
      if (Array.isArray(r.recipeInstructions)) {
        steps = r.recipeInstructions.map(s => typeof s === 'string' ? s : ((s && (s.text || s.name)) || '')).filter(Boolean);
      } else if (typeof r.recipeInstructions === 'string') {
        steps = r.recipeInstructions.split(/\n+/).map(s => s.trim()).filter(Boolean);
      }
      if (title && ingredientLines.length) return { title, basePortions: portions, ingredientLines, steps };
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function importUrlPrompt(pageText) {
  return `Je krijgt de platte tekst van een receptenpagina. Haal er het recept uit.
Categorie is één van: Hoofdmaaltijd, Salade, Ontbijt, Snack, Dessert, Extra
(volledige gerechten) of Eiwit, Groenten, Bijgerecht, Saus (als het enkel
een onderdeel is, bv. enkel een stuk vlees of enkel een groentebereiding).
basePortions is het aantal porties dat de pagina zelf vermeldt (schat 2 als
niets vermeld staat). Ingrediënten met een duidelijke hoeveelheid en eenheid
waar mogelijk; anders amount null en de vrije tekst in unit.
Geef ALLEEN geldig JSON terug, exact in dit formaat, zonder uitleg erbij:
{"title":"...","category":"Hoofdmaaltijd","basePortions":2,
"ingredients":[{"name":"...","amount":300,"unit":"g"}],"steps":["...","..."]}

PAGINATEKST:
${pageText}`;
}

async function handleImportUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Ongeldige URL');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Mealio/1.0; recipe-importer)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Pagina gaf status ${res.status} terug`);
  const html = await res.text();

  const schema = extractSchemaRecipe(html);
  if (schema) {
    return {
      title: schema.title, category: '', basePortions: schema.basePortions,
      ingredients: schema.ingredientLines.map(parseIngredientLineLoose),
      steps: schema.steps, method: 'schema',
    };
  }
  const result = await callGemini(importUrlPrompt(stripHtml(html)));
  return { ...result, method: 'ai' };
}

// Simpele losse ingrediëntregel-parser (fallback voor Schema.org-lijsten,
// die vaak platte tekst zijn zoals "300 g kipfilet").
function parseIngredientLineLoose(line) {
  const m = line.match(/^([\d.,/]+)\s*(g|kg|ml|l|el|tl|stuks?|teentjes?|blaadjes?)?\s+(.+)$/i);
  if (m) {
    const amount = parseFloat(m[1].replace(',', '.').replace('/', '.'));
    return { name: m[3].trim(), amount: isNaN(amount) ? null : amount, unit: m[2] || '' };
  }
  return { name: line.trim(), amount: null, unit: '' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Wie roept dit aan? verify_jwt (standaard aan) garandeert al dat er
    // geldig ingelogd is; hier vragen we met de JWT van de gebruiker aan de
    // database of dit adres op de toegangslijst staat (zelfde regel als RLS).
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
    );
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return json({ error: 'Niet ingelogd' }, 401);
    const { data: allowed, error: allowErr } = await supabaseClient.rpc('is_allowed_user');
    if (allowErr || allowed !== true) {
      return json({ error: 'Niet toegelaten — dit adres staat niet op de toegangslijst' }, 403);
    }
    const body = await req.json();

    if (body.task === 'import_url') {
      const result = await handleImportUrl(body.url);
      return json(result);
    }
    if (body.task === 'import_photo') {
      const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
      let files = Array.isArray(body.files) ? body.files : [];
      if (!files.length && body.imageBase64) files = [{ data: body.imageBase64, mimeType: body.mimeType || 'image/jpeg' }];
      files = files.filter(f => f && typeof f.data === 'string' && f.data && ALLOWED.test(f.mimeType || '')).slice(0, 5);
      if (!files.length) throw new Error('Geen foto of PDF ontvangen');
      const total = files.reduce((n, f) => n + f.data.length, 0);
      if (total > 18_000_000) throw new Error('Bestanden te groot (samen max ± 13 MB)');
      const result = await callGeminiParts([{ text: importPhotoPrompt() },
        ...files.map(f => ({ inline_data: { mime_type: f.mimeType, data: f.data } }))]);
      return json({ ...result, method: files.some(f => f.mimeType === 'application/pdf') ? 'pdf' : 'photo' });
    }
    if (body.task === 'scan_pantry') {
      if (!body.imageBase64) throw new Error('Geen foto ontvangen');
      const result = await callGeminiVision(scanPantryPrompt(), body.imageBase64, body.mimeType);
      const items = Array.isArray(result && result.items) ? result.items.map(s => String(s).trim()).filter(Boolean) : [];
      return json({ items: [...new Set(items)].slice(0, 60) });
    }

    const prompt = buildPrompt(body);
    return json(await callGemini(prompt));
  } catch (e) {
    return json({ error: e.message || 'Onbekende fout' }, 500);
  }
});
