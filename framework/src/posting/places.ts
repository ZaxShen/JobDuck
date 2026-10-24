export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii',
  ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

export const CA_PROVINCES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'united states|united states of america|usa|u.s.|u.s.a.|america',
  CA: 'canada',
  MX: 'mexico',
  BR: 'brazil|brasil',
  AR: 'argentina',
  CL: 'chile',
  CO: 'colombia',
  PE: 'peru',
  GB: 'united kingdom|uk|u.k.|great britain|england|scotland|wales|northern ireland',
  IE: 'ireland',
  FR: 'france',
  DE: 'germany|deutschland',
  NL: 'netherlands|the netherlands|holland',
  BE: 'belgium',
  LU: 'luxembourg',
  CH: 'switzerland',
  AT: 'austria',
  ES: 'spain',
  PT: 'portugal',
  IT: 'italy',
  DK: 'denmark',
  SE: 'sweden',
  NO: 'norway',
  FI: 'finland',
  IS: 'iceland',
  PL: 'poland',
  CZ: 'czech republic|czechia',
  SK: 'slovakia',
  HU: 'hungary',
  RO: 'romania',
  BG: 'bulgaria',
  GR: 'greece',
  HR: 'croatia',
  RS: 'serbia',
  SI: 'slovenia',
  EE: 'estonia',
  LV: 'latvia',
  LT: 'lithuania',
  UA: 'ukraine',
  TR: 'turkey|türkiye|turkiye',
  IL: 'israel',
  AE: 'united arab emirates|uae',
  SA: 'saudi arabia',
  QA: 'qatar',
  EG: 'egypt',
  ZA: 'south africa',
  NG: 'nigeria',
  KE: 'kenya',
  IN: 'india',
  PK: 'pakistan',
  BD: 'bangladesh',
  LK: 'sri lanka',
  CN: 'china',
  HK: 'hong kong',
  TW: 'taiwan',
  JP: 'japan',
  KR: 'south korea|korea|republic of korea',
  SG: 'singapore',
  MY: 'malaysia',
  TH: 'thailand',
  VN: 'vietnam|viet nam',
  PH: 'philippines',
  ID: 'indonesia',
  AU: 'australia',
  NZ: 'new zealand',
}

const COUNTRY_BY_NAME = new Map<string, string>(
  Object.entries(COUNTRY_NAMES).flatMap(([code, names]) => names.split('|').map((name) => [name, code])),
)
const COUNTRY_CODES = new Set(Object.keys(COUNTRY_NAMES))
const ALPHA3: Record<string, string> = { USA: 'US', CAN: 'CA', GBR: 'GB', DEU: 'DE', FRA: 'FR', IND: 'IN', AUS: 'AU' }

const placeKey = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ')

export function countryCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed) && (COUNTRY_CODES.has(trimmed.toUpperCase()) || trimmed === trimmed.toUpperCase())) {
    return trimmed.toUpperCase() === 'UK' ? 'GB' : trimmed.toUpperCase()
  }
  return ALPHA3[trimmed.toUpperCase()] ?? COUNTRY_BY_NAME.get(placeKey(trimmed))
}

export function isCountryName(value: string): boolean {
  return COUNTRY_BY_NAME.has(placeKey(value)) || ALPHA3[value.trim().toUpperCase()] !== undefined
}

function lookupRegion(table: Record<string, string>, value: string): string | undefined {
  const trimmed = value.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed) && table[trimmed.toUpperCase()] && trimmed === trimmed.toUpperCase()) {
    return trimmed.toUpperCase()
  }
  const wanted = placeKey(trimmed)
  return Object.keys(table).find((code) => placeKey(table[code]!) === wanted)
}

export interface Region {
  code: string
  country: 'US' | 'CA'
}

export function regionOf(value: string, country?: string): Region | undefined {
  if (country === 'CA') {
    const code = lookupRegion(CA_PROVINCES, value)
    return code ? { code, country: 'CA' } : undefined
  }
  const us = lookupRegion(US_STATES, value)
  if (us) return { code: us, country: 'US' }
  if (country === 'US') return undefined
  const ca = lookupRegion(CA_PROVINCES, value)
  return ca ? { code: ca, country: 'CA' } : undefined
}
