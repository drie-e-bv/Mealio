// ÉÉNMALIG migratiescript: leest de bestaande data/recipes.json en
// data/planner.json (het oude, lokale opslagformaat) en zet alles over naar
// Supabase. Draai dit vóór je overschakelt naar de nieuwe server.js, terwijl
// de map met je huidige data/ nog naast dit script staat.
//
// Gebruik (op de NAS, of lokaal met dezelfde data/-map ernaast):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... node migrate-to-supabase.js
//
// Vereist Node.js 18+ (voor de ingebouwde fetch). Geen npm-install nodig.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Zet SUPABASE_URL en SUPABASE_SERVICE_KEY als environment variables voor je dit script draait.');
  process.exit(1);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

async function sb(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// Maandag van de huidige week, als YYYY-MM-DD — de oude weekmenu-data had
// geen datum (het was een terugkerend sjabloon), dus we zetten 'm over als
// de huidige week.
function currentMonday() {
  const d = new Date();
  const day = d.getDay(); // 0=zondag..6=zaterdag
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const recipesFile = path.join(DATA_DIR, 'recipes.json');
  const plannerFile = path.join(DATA_DIR, 'planner.json');
  if (!fs.existsSync(recipesFile) && !fs.existsSync(plannerFile)) {
    console.error(`Geen data gevonden in ${DATA_DIR} — niets te migreren.`);
    process.exit(1);
  }

  const oldRecipes = readJSON(recipesFile, []);
  const planner = readJSON(plannerFile, {});
  const weekmenu = planner.weekmenu || {};
  const stores = planner.stores && planner.stores.length ? planner.stores : ['Colruyt', 'Okay', 'Slager', 'Bakker'];
  const itemStoreMap = planner.itemStoreMap || {};
  const checkedItems = planner.checkedItems || {};
  const extraItems = planner.extraItems || [];
  const pantryStock = planner.pantryStock || [];
  const aiSuggestions = planner.aiSuggestions || [];

  console.log(`Gevonden: ${oldRecipes.length} recepten, ${Object.keys(weekmenu).length} dagen in weekmenu, ${stores.length} winkels, ${pantryStock.length} kastitems, ${aiSuggestions.length} wachtlijst-items.`);

  // 1. Recepten — oude string-id's bewaren we in een mapping naar de nieuwe uuid's
  const idMap = {};
  console.log('Recepten overzetten…');
  for (const r of oldRecipes) {
    const row = {
      title: r.title, category: r.category || '',
      portions_base: Number(r.basePortions) || 1,
      ingredients: r.ingredients || [], steps: r.steps || [],
      stars: r.stars || null, source: 'manual',
    };
    const created = await sb('recipes', { method: 'POST', body: row, prefer: 'return=representation' });
    idMap[r.id] = created[0].id;
  }
  console.log(`  → ${oldRecipes.length} recepten aangemaakt.`);

  // 2. Weekmenu → huidige week
  console.log('Weekmenu overzetten naar de huidige week…');
  const weekStart = currentMonday();
  let count = 0;
  for (const [day, meals] of Object.entries(weekmenu)) {
    for (const [meal, slot] of Object.entries(meals)) {
      if (!slot) continue;
      const hasContent = slot.recipeId || slot.category;
      if (!hasContent) continue;
      await sb('weekmenu_entries?on_conflict=week_start,day,meal', {
        method: 'POST',
        body: {
          week_start: weekStart, day, meal,
          persons: Number(slot.persons) || 1,
          type: slot.category || null,
          recipe_id: slot.recipeId ? (idMap[slot.recipeId] || null) : null,
          locked: false,
        },
        prefer: 'resolution=merge-duplicates',
      });
      count++;
    }
  }
  console.log(`  → ${count} maaltijden gezet op week_start ${weekStart}.`);

  // 3. Instellingen
  console.log('Instellingen (winkels, boodschappenlijst-status) overzetten…');
  const settingsRows = [
    { key: 'stores', value: stores },
    { key: 'item_store_map', value: itemStoreMap },
    { key: 'checked_items', value: checkedItems },
    { key: 'extra_items', value: extraItems },
  ];
  for (const row of settingsRows) {
    await sb('app_settings?on_conflict=key', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates' });
  }
  console.log('  → instellingen overgezet.');

  // 4. In de kast
  if (pantryStock.length) {
    console.log('Kastvoorraad overzetten…');
    for (const item of pantryStock) {
      await sb('pantry_stock?on_conflict=ingredient_name', {
        method: 'POST',
        body: { ingredient_name: item.name, in_stock: !!item.inStock },
        prefer: 'resolution=merge-duplicates',
      });
    }
    console.log(`  → ${pantryStock.length} kastitems overgezet.`);
  }

  // 5. Wachtlijst
  if (aiSuggestions.length) {
    console.log('Wachtlijst overzetten…');
    for (const s of aiSuggestions) {
      await sb('ai_recipe_suggestions', {
        method: 'POST',
        body: {
          title: s.title, category: s.category || '', portions_base: s.basePortions || 1,
          ingredients: s.ingredients || [], steps: s.steps || [],
          based_on_ingredients: s.basedOn || [], status: 'pending',
        },
      });
    }
    console.log(`  → ${aiSuggestions.length} wachtlijst-items overgezet.`);
  }

  console.log('\nKlaar! Controleer de data in je Supabase-dashboard (Table editor) voor je de oude server.js/data-map opruimt.');
}

main().catch((e) => { console.error('Migratie mislukt:', e.message); process.exit(1); });
