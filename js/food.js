// Healthy, filling and cheap food data for Chile. Prices are 2026 estimates in CLP
// (supermarket/feria, one person) and can be edited from the app.

export const FOOD_CATEGORIES = ['comida', 'supermercado', 'delivery'];

export const CATALOG = [
  { id: 'avena', name: 'Avena', unit: '1 kg', price: 2200, qty: 1, priority: 1, group: 'Despensa' },
  { id: 'huevos', name: 'Huevos', unit: 'docena', price: 2900, qty: 2, priority: 1, group: 'Proteínas' },
  { id: 'pollo', name: 'Trutro de pollo entero', unit: '1 kg', price: 3600, qty: 2, priority: 1, group: 'Proteínas' },
  { id: 'lentejas', name: 'Lentejas', unit: '500 g', price: 1100, qty: 1, priority: 1, group: 'Legumbres' },
  { id: 'porotos', name: 'Porotos', unit: '500 g', price: 1500, qty: 1, priority: 2, group: 'Legumbres' },
  { id: 'garbanzos', name: 'Garbanzos', unit: '500 g', price: 1400, qty: 1, priority: 2, group: 'Legumbres' },
  { id: 'arroz', name: 'Arroz', unit: '1 kg', price: 1500, qty: 1, priority: 1, group: 'Despensa' },
  { id: 'papas', name: 'Papas (feria)', unit: '1 kg', price: 1100, qty: 2, priority: 1, group: 'Verduras' },
  { id: 'zanahoria', name: 'Zanahorias', unit: '1 kg', price: 1000, qty: 1, priority: 1, group: 'Verduras' },
  { id: 'cebolla', name: 'Cebollas', unit: '1 kg', price: 1100, qty: 1, priority: 1, group: 'Verduras' },
  { id: 'tomate', name: 'Tomates', unit: '1 kg', price: 1600, qty: 1, priority: 1, group: 'Verduras' },
  { id: 'platano', name: 'Plátanos', unit: '1 kg', price: 1400, qty: 1, priority: 1, group: 'Frutas' },
  { id: 'jurel', name: 'Jurel en lata', unit: '425 g', price: 1900, qty: 1, priority: 2, group: 'Proteínas' },
  { id: 'fideos', name: 'Fideos integrales', unit: '400 g', price: 1300, qty: 1, priority: 2, group: 'Despensa' },
  { id: 'lechuga', name: 'Lechuga', unit: 'unidad', price: 900, qty: 2, priority: 2, group: 'Verduras' },
  { id: 'zapallo', name: 'Zapallo camote', unit: '1 kg', price: 1200, qty: 1, priority: 2, group: 'Verduras' },
  { id: 'repollo', name: 'Repollo', unit: 'unidad', price: 1300, qty: 1, priority: 2, group: 'Verduras' },
  { id: 'acelga', name: 'Acelga o espinaca', unit: 'atado', price: 1000, qty: 1, priority: 2, group: 'Verduras' },
  { id: 'temporada', name: 'Fruta de temporada', unit: '1 kg', price: 2000, qty: 1, priority: 2, group: 'Frutas' },
  { id: 'leche', name: 'Leche descremada', unit: '1 L', price: 1100, qty: 3, priority: 2, group: 'Lácteos' },
  { id: 'pan', name: 'Pan integral o marraqueta', unit: '1 kg', price: 2400, qty: 1, priority: 2, group: 'Despensa' },
  { id: 'alinos', name: 'Aceite, sal y aliños (prorrateo)', unit: 'semana', price: 800, qty: 1, priority: 2, group: 'Despensa' },
  { id: 'manzana', name: 'Manzanas', unit: '1 kg', price: 1400, qty: 1, priority: 3, group: 'Frutas' },
  { id: 'atun', name: 'Atún en agua', unit: 'lata', price: 1300, qty: 1, priority: 3, group: 'Proteínas' },
  { id: 'yogurt', name: 'Yogurt natural sin azúcar', unit: '1 kg', price: 2600, qty: 1, priority: 3, group: 'Lácteos' },
  { id: 'quesillo', name: 'Quesillo', unit: 'unidad', price: 2400, qty: 1, priority: 3, group: 'Lácteos' },
];

export const SEASONAL_FRUIT = {
  1: 'sandía, melón, duraznos', 2: 'duraznos, uvas, sandía', 3: 'uvas, peras, manzanas',
  4: 'manzanas, peras, uvas', 5: 'mandarinas, manzanas, kiwis', 6: 'naranjas, mandarinas, kiwis',
  7: 'naranjas, kiwis, limones', 8: 'naranjas, kiwis, pomelos', 9: 'naranjas, kiwis, primeras frutillas',
  10: 'frutillas, nísperos, naranjas', 11: 'frutillas, cerezas, damascos', 12: 'cerezas, damascos, duraznos, sandía',
};

// cost = estimated CLP per serving. Ideas favor protein + fiber for satiety.
export const MEALS = [
  { name: 'Avena cocida con plátano y canela', type: 'Desayuno', cost: 450, why: 'Fibra que te deja lleno hasta el almuerzo.' },
  { name: 'Huevos revueltos con tomate + ½ marraqueta', type: 'Desayuno', cost: 750, why: 'Proteína barata y rápida.' },
  { name: 'Yogurt natural con avena y fruta de temporada', type: 'Desayuno', cost: 850, why: 'Proteína + fibra, sin azúcar agregada.' },
  { name: 'Lentejas con arroz y ensalada chilena', type: 'Almuerzo', cost: 900, why: 'Legumbre + cereal = proteína completa.' },
  { name: 'Porotos con riendas (sin longaniza) + ensalada', type: 'Almuerzo', cost: 1100, why: 'Muy saciador y económico.' },
  { name: 'Garbanzos guisados con zapallo y espinaca', type: 'Almuerzo', cost: 1000, why: 'Fibra y hierro; rinde para dos días.' },
  { name: 'Cazuela de pollo con zapallo, papa y verduras', type: 'Almuerzo', cost: 1800, why: 'Plato completo con mucha verdura.' },
  { name: 'Pollo al horno con ensalada de repollo y zanahoria', type: 'Almuerzo', cost: 1700, why: 'Prepara 4 porciones el domingo.' },
  { name: 'Charquicán con huevo y ensalada', type: 'Almuerzo', cost: 1200, why: 'Verduras de feria que rinden mucho.' },
  { name: 'Jurel con papas cocidas y ensalada', type: 'Almuerzo', cost: 1300, why: 'Omega 3 a precio bajo.' },
  { name: 'Fideos integrales con salsa de tomate y atún', type: 'Cena', cost: 1100, why: 'Porción moderada de pasta + proteína.' },
  { name: 'Tortilla de acelga con ensalada', type: 'Cena', cost: 900, why: 'Liviana pero con proteína.' },
  { name: 'Arroz salteado con verduras y huevo', type: 'Cena', cost: 900, why: 'Aprovecha sobras de verduras.' },
  { name: 'Ensalada completa: lechuga, tomate, huevo duro y pollo', type: 'Cena', cost: 1400, why: 'Volumen alto con pocas calorías.' },
  { name: 'Sopa de verduras con lentejas', type: 'Cena', cost: 700, why: 'Muy saciadora en invierno.' },
  { name: 'Fruta de temporada', type: 'Colación', cost: 400, why: 'Dulce natural con fibra.' },
  { name: 'Huevo duro + palitos de zanahoria', type: 'Colación', cost: 350, why: 'Corta el hambre entre comidas.' },
  { name: 'Leche o yogurt natural', type: 'Colación', cost: 500, why: 'Proteína para llegar a la cena sin hambre.' },
];

export const HABITS = [
  'Prepara el almuerzo del día siguiente cuando cocinas la cena.',
  'Llena medio plato con verduras, un cuarto con proteína y un cuarto con legumbres o cereal.',
  'Toma agua antes de comer; muchas veces la sed se confunde con hambre.',
  'Cocina en lote el domingo (legumbres y pollo) para 3–4 días.',
  'Compra verduras en la feria al final del día: más barato y fresco.',
  'Evita llegar con hambre al supermercado: compra solo lo de la lista.',
];

export function withPrices(catalog, overrides = {}) {
  return catalog.map((i) => (overrides[i.id] ? { ...i, price: Number(overrides[i.id]) } : i));
}
