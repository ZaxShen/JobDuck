const COUNTRY_CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT
MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG
UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/)

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
]

const CA_PROVINCES = [
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Northwest Territories',
  'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Yukon',
]

const METROS: Record<string, readonly string[]> = {
  US: [
    'San Francisco Bay Area', 'New York City', 'Seattle', 'Los Angeles', 'Boston', 'Austin', 'Chicago', 'Washington DC',
    'Denver', 'Atlanta', 'Dallas', 'Houston', 'Miami', 'San Diego', 'Philadelphia', 'Phoenix', 'Portland', 'Minneapolis',
    'Salt Lake City', 'Raleigh-Durham', 'Pittsburgh', 'Detroit', 'Nashville', 'Charlotte', 'Baltimore', 'St. Louis',
    'Kansas City', 'Columbus', 'Las Vegas', 'Sacramento',
  ],
  CA: ['Toronto', 'Vancouver', 'Montreal', 'Ottawa', 'Calgary', 'Waterloo', 'Edmonton'],
  GB: ['London', 'Manchester', 'Edinburgh', 'Cambridge', 'Oxford', 'Bristol', 'Birmingham', 'Glasgow', 'Leeds', 'Belfast'],
  IE: ['Dublin'],
  DE: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart', 'Düsseldorf'],
  FR: ['Paris', 'Lyon', 'Toulouse'],
  NL: ['Amsterdam', 'Rotterdam', 'Eindhoven', 'The Hague', 'Utrecht'],
  BE: ['Brussels'],
  LU: ['Luxembourg City'],
  CH: ['Zurich', 'Geneva', 'Basel', 'Lausanne'],
  AT: ['Vienna'],
  ES: ['Madrid', 'Barcelona', 'Valencia'],
  PT: ['Lisbon', 'Porto'],
  IT: ['Milan', 'Rome'],
  DK: ['Copenhagen'],
  SE: ['Stockholm', 'Gothenburg', 'Malmö'],
  NO: ['Oslo'],
  FI: ['Helsinki'],
  EE: ['Tallinn'],
  LV: ['Riga'],
  LT: ['Vilnius'],
  PL: ['Warsaw', 'Kraków', 'Wrocław'],
  CZ: ['Prague'],
  HU: ['Budapest'],
  RO: ['Bucharest'],
  BG: ['Sofia'],
  GR: ['Athens'],
  RS: ['Belgrade'],
  UA: ['Kyiv'],
  TR: ['Istanbul', 'Ankara'],
  IL: ['Tel Aviv'],
  AE: ['Dubai', 'Abu Dhabi'],
  SA: ['Riyadh'],
  QA: ['Doha'],
  EG: ['Cairo'],
  ZA: ['Cape Town', 'Johannesburg'],
  NG: ['Lagos'],
  KE: ['Nairobi'],
  MA: ['Casablanca'],
  GH: ['Accra'],
  IN: ['Bengaluru', 'Hyderabad', 'Mumbai', 'Delhi NCR', 'Pune', 'Chennai', 'Kolkata', 'Ahmedabad', 'Kochi'],
  CN: ['Beijing', 'Shanghai', 'Shenzhen', 'Hangzhou', 'Guangzhou', 'Chengdu'],
  TW: ['Taipei', 'Hsinchu'],
  JP: ['Tokyo', 'Osaka', 'Kyoto', 'Fukuoka'],
  KR: ['Seoul', 'Busan'],
  AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra'],
  NZ: ['Auckland', 'Wellington'],
  MY: ['Kuala Lumpur'],
  TH: ['Bangkok'],
  VN: ['Ho Chi Minh City', 'Hanoi'],
  PH: ['Manila'],
  ID: ['Jakarta'],
  PK: ['Karachi', 'Lahore', 'Islamabad'],
  BD: ['Dhaka'],
  MX: ['Mexico City', 'Guadalajara', 'Monterrey'],
  BR: ['São Paulo', 'Rio de Janeiro', 'Florianópolis'],
  AR: ['Buenos Aires'],
  CL: ['Santiago'],
  CO: ['Bogotá', 'Medellín'],
  PE: ['Lima'],
  UY: ['Montevideo'],
  CR: ['San José'],
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

export const LOCATION_LIMIT = 50

export const LOCATIONS: readonly string[] = [...new Set([
  'Remote',
  ...Object.entries(METROS).flatMap(([code, cities]) => cities.map((city) => `${city}, ${code}`)),
  ...COUNTRY_CODES.map((code) => regionNames.of(code) ?? code),
  ...US_STATES.map((state) => `${state}, US`),
  ...CA_PROVINCES.map((province) => `${province}, CA`),
])]

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

const FOLDED = new Map(LOCATIONS.map((location) => [location, fold(location)]))

export function searchLocations(query: string, limit = LOCATION_LIMIT): string[] {
  const needle = fold(query.trim())
  if (!needle) return LOCATIONS.slice(0, limit)
  const starts: string[] = []
  const contains: string[] = []
  for (const location of LOCATIONS) {
    const folded = FOLDED.get(location) ?? fold(location)
    if (folded.startsWith(needle)) starts.push(location)
    else if (folded.includes(needle)) contains.push(location)
  }
  return [...starts, ...contains].slice(0, limit)
}
