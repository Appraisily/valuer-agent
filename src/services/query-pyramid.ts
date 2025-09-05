/*
  Query Pyramid Builder for art, antiques, jewelry, watches, and general collectibles.
  Produces grouped search terms by specificity level that map to auction catalog parlance.
*/

export type Category = 'art' | 'furniture' | 'decorative' | 'jewelry' | 'watches' | 'coins' | 'collectibles' | 'unknown';

export interface PyramidInput {
  description: string;
  category?: Category | string;
  maker?: string;     // artist, maker
  brand?: string;     // for watches/jewelry
  model?: string;     // watch model / reference
  subject?: string;   // e.g., interior, portrait, landscape
  styleEra?: string;  // e.g., rococo revival, art deco, victorian
  mediumMaterial?: string; // e.g., oil on canvas, sterling silver, mahogany, bronze
  region?: string;    // e.g., French, English, American
}

export interface QueryGroups {
  'very specific': string[];
  'specific': string[];
  'moderate': string[];
  'broad': string[];
  'very broad': string[];
}

const WORD = /[A-Za-zÀ-ÖØ-öø-ÿ0-9'.-]+/g;

function norm(s?: string): string { return (s || '').trim(); }
function capWords(s?: string): string { return norm(s).split(/\s+/).map(w => w.length ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim(); }
function has(text: string, term: string) { return text.toLowerCase().includes(term.toLowerCase()); }
function uniq(arr: string[]): string[] { const seen = new Set<string>(); const out: string[] = []; for (const a of arr.map(x=>x.trim()).filter(Boolean)) { if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); out.push(a); } } return out; }

function inferCategory(text: string): Category {
  const t = text.toLowerCase();
  if (/\b(oil|canvas|watercolor|gouache|lithograph|etching|engraving|pastel|acrylic|mixed media|tempera|painting|artwork|signed)\b/.test(t)) return 'art';
  if (/\b(sofa|chair|armchair|fauteuil|berg[eè]re|table|console|commode|cabinet|desk|dresser|sideboard|bookcase|stool|bench|buffet|mahogany|walnut|oak|veneer)\b/.test(t)) return 'furniture';
  if (/\b(porcelain|ceramic|china|faience|stoneware|earthenware|meissen|limoges|sevres|bronze|brass|spelter|copper|vase|figurine|candelabra|clock)\b/.test(t)) return 'decorative';
  if (/\b(ring|necklace|pendant|brooch|earrings|bracelet|jewel|jewelry|diamond|ruby|sapphire|emerald|gold|platinum|14k|18k|sterling|925)\b/.test(t)) return 'jewelry';
  if (/\b(watch|chronograph|submariner|daytona|seamaster|speedmaster|rolex|omega|patek|audemars|tudor|cartier|tag heuer)\b/.test(t)) return 'watches';
  if (/\b(coin|numismatic|silver dollar|denarius|sovereign|penny|cent|mint|proof|uncirculated)\b/.test(t)) return 'coins';
  if (/\b(stamp|toy|comic|trading card|sports card|figurine|collectible|memorabilia|poster)\b/.test(t)) return 'collectibles';
  return 'unknown';
}

function splitWords(s: string): string[] {
  const m = s.match(WORD) || [];
  return m.map(x => x.toLowerCase());
}

function pickFromText(text: string) {
  const words = splitWords(text);
  const styles = ['rococo', 'rococo revival', 'neo-rococo', 'baroque', 'neoclassical', 'empire', 'regency', 'georgian', 'victorian', 'edwardian', 'art nouveau', 'art deco', 'mid-century', 'arts and crafts', 'modernist'];
  const mediums = ['oil on canvas', 'oil', 'canvas', 'watercolor', 'gouache', 'acrylic', 'pastel', 'ink', 'lithograph', 'etching', 'engraving', 'bronze', 'porcelain', 'ceramic', 'mahogany', 'walnut', 'oak', 'silver', 'sterling silver', 'gold', 'platinum'];
  const subjects = ['interior', 'genre scene', 'salon scene', 'parlor scene', 'elegant company', 'courting couple', 'portrait', 'landscape', 'still life', 'seascape'];
  const types = ['painting', 'oil painting', 'lithograph', 'etching', 'print', 'sculpture', 'vase', 'clock', 'candelabra', 'chair', 'armchair', 'table', 'console', 'commode', 'cabinet', 'ring', 'necklace', 'brooch', 'watch'];
  const found = (arr: string[]) => arr.filter(k => words.join(' ').includes(k)).sort((a,b)=>b.length-a.length);
  return {
    style: found(styles)[0] || '',
    medium: found(mediums)[0] || '',
    subject: found(subjects)[0] || '',
    type: found(types)[0] || ''
  };
}

function artQueries(base: PyramidInput, picks: ReturnType<typeof pickFromText>) {
  const maker = capWords(base.maker);
  const subj = capWords(base.subject || picks.subject);
  const style = capWords(base.styleEra || picks.style);
  const medium = capWords(base.mediumMaterial || picks.medium);
  const type = medium.toLowerCase().includes('oil') ? 'oil painting' : (picks.type || 'painting');

  const verySpecific = uniq([
    maker && subj ? `${maker} ${subj}` : '',
    maker && medium ? `${maker} ${medium}` : '',
    maker && style ? `${maker} ${style}` : '',
  ]);

  const specific = uniq([
    maker || '',
    subj ? `${subj} ${type}` : type,
    style ? `${style} ${type}` : type,
    medium || type,
  ]);

  const moderate = uniq([
    style && subj ? `${style} ${subj}` : '',
    subj || '',
    style || '',
    type,
  ]);

  const broad = uniq([
    medium || type,
    'genre painting',
    'interior painting',
    'fine art',
  ]);

  const veryBroad = ['art', 'painting'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

function furnitureQueries(base: PyramidInput, picks: ReturnType<typeof pickFromText>) {
  const maker = capWords(base.maker);
  const style = capWords(base.styleEra || picks.style);
  const region = capWords(base.region);
  const type = capWords(picks.type) || 'chair';
  const materials = ['mahogany', 'walnut', 'oak', 'rosewood', 'giltwood'];
  const material = capWords(materials.find(m => has((base.mediumMaterial||'') + ' ' + base.description, m)) || '');

  const verySpecific = uniq([
    maker ? `${maker} ${type}` : '',
    style && type ? `${style} ${type}` : '',
    region && type ? `${region} ${type}` : ''
  ]);
  const specific = uniq([
    material ? `${material} ${type}` : type,
    style || '',
    region || ''
  ]);
  const moderate = uniq([
    `${type}`,
    material || '',
  ]);
  const broad = uniq([
    'antique furniture',
    'period furniture'
  ]);
  const veryBroad = ['furniture'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

function decorativeQueries(base: PyramidInput, picks: ReturnType<typeof pickFromText>) {
  const maker = capWords(base.maker);
  const style = capWords(base.styleEra || picks.style);
  const type = capWords(picks.type) || 'vase';
  const material = capWords(base.mediumMaterial || picks.medium || 'porcelain');
  const verySpecific = uniq([
    maker ? `${maker} ${type}` : '',
    style && type ? `${style} ${type}` : '',
  ]);
  const specific = uniq([
    `${material} ${type}`,
    style || '',
    maker || ''
  ]);
  const moderate = uniq([
    type,
    material,
  ]);
  const broad = uniq([
    'decorative arts',
    'antique decorative'
  ]);
  const veryBroad = ['decorative'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

function jewelryQueries(base: PyramidInput, _picks: ReturnType<typeof pickFromText>) {
  const brand = capWords(base.brand || base.maker);
  const material = capWords(base.mediumMaterial || 'gold');
  const type = (() => {
    const t = base.description.toLowerCase();
    if (t.includes('ring')) return 'ring';
    if (t.includes('necklace') || t.includes('pendant')) return 'necklace';
    if (t.includes('brooch') || t.includes('pin')) return 'brooch';
    if (t.includes('earring')) return 'earrings';
    if (t.includes('bracelet')) return 'bracelet';
    return 'ring';
  })();
  const gemstone = (() => {
    const g = ['diamond', 'ruby', 'sapphire', 'emerald', 'pearl'];
    const found = g.find(x => has(base.description, x));
    return capWords(found || '');
  })();
  const era = capWords(base.styleEra || '');
  const verySpecific = uniq([
    brand ? `${brand} ${type}` : '',
    gemstone && type ? `${gemstone} ${type}` : '',
    era && type ? `${era} ${type}` : ''
  ]);
  const specific = uniq([
    `${material} ${type}`,
    gemstone || '',
    brand || ''
  ]);
  const moderate = uniq([
    type,
    material,
  ]);
  const broad = uniq([
    'antique jewelry',
    'estate jewelry'
  ]);
  const veryBroad = ['jewelry'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

function watchQueries(base: PyramidInput, _picks: ReturnType<typeof pickFromText>) {
  const brand = capWords(base.brand || base.maker || '');
  const model = capWords(base.model || '');
  const material = has(base.description, 'stainless') ? 'stainless steel' : (has(base.description, 'gold') ? 'gold' : '');
  const features: string[] = [];
  if (has(base.description, 'chronograph')) features.push('chronograph');
  if (has(base.description, 'automatic')) features.push('automatic');
  const verySpecific = uniq([
    brand && model ? `${brand} ${model}` : '',
    brand && features[0] ? `${brand} ${features[0]}` : ''
  ]);
  const specific = uniq([
    brand || '',
    model || '',
    material ? `${material} watch` : '',
  ]);
  const moderate = uniq([
    features[0] ? `${features[0]} watch` : 'watch',
    'men\'s watch'
  ]);
  const broad = uniq(['vintage watch', 'luxury watch']);
  const veryBroad = ['watch'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

function coinsQueries(base: PyramidInput, _picks: ReturnType<typeof pickFromText>) {
  const verySpecific: string[] = [];
  const specific: string[] = [];
  const moderate = ['gold coin', 'silver coin'];
  const broad = ['numismatic coin'];
  const veryBroad = ['coin'];
  const t = base.description.toLowerCase();
  if (/\b(sovereign|denarius|ducat|eagle|florin|dollar|cent|penny)\b/.test(t)) specific.push(capWords(RegExp.$1 + ' coin'));
  return { 'very specific': uniq(verySpecific), specific: uniq(specific), moderate: uniq(moderate), broad, 'very broad': veryBroad } as QueryGroups;
}

function generalQueries(base: PyramidInput, picks: ReturnType<typeof pickFromText>) {
  const style = capWords(base.styleEra || picks.style);
  const type = capWords(picks.type || base.subject || 'collectible');
  const verySpecific = uniq([style && type ? `${style} ${type}` : '']);
  const specific = uniq([type, style].filter(Boolean) as string[]);
  const moderate = uniq([type]);
  const broad = ['antique', 'vintage'];
  const veryBroad = ['collectible'];
  return { 'very specific': verySpecific, specific, moderate, broad, 'very broad': veryBroad } as QueryGroups;
}

export function buildQueryPyramid(input: PyramidInput): QueryGroups {
  const description = input.description || '';
  const cat: Category = ((): Category => {
    const c = (input.category || '').toString().toLowerCase().trim();
    if (!c) return inferCategory(description);
    if (['art','painting','fine art'].includes(c)) return 'art';
    if (['furniture'].includes(c)) return 'furniture';
    if (['decorative','decorative arts','porcelain','ceramics'].includes(c)) return 'decorative';
    if (['jewelry','jewellery'].includes(c)) return 'jewelry';
    if (['watch','watches','timepiece'].includes(c)) return 'watches';
    if (['coin','coins','numismatic'].includes(c)) return 'coins';
    if (['collectibles','collectible'].includes(c)) return 'collectibles';
    return inferCategory(description);
  })();
  const picks = pickFromText(description);

  switch (cat) {
    case 'art': return artQueries(input, picks);
    case 'furniture': return furnitureQueries(input, picks);
    case 'decorative': return decorativeQueries(input, picks);
    case 'jewelry': return jewelryQueries(input, picks);
    case 'watches': return watchQueries(input, picks);
    case 'coins': return coinsQueries(input, picks);
    default: return generalQueries(input, picks);
  }
}

export function flattenPyramid(groups: QueryGroups, max?: number): string[] {
  // Order: moderate -> specific -> very specific -> broad -> very broad
  const order: Array<keyof QueryGroups> = ['moderate', 'specific', 'very specific', 'broad', 'very broad'];
  const out: string[] = [];
  for (const key of order) {
    for (const term of groups[key] || []) {
      out.push(term);
      if (typeof max === 'number' && max > 0 && out.length >= max) return out;
    }
  }
  return out;
}
