// Single list of the countries a product can be made in (user request
// 2026-10-01: Country of Origin is a dropdown of every country). The PIM
// stores the English name (attributes.country_of_origin — "China",
// "Vietnam"); marketplaces that want a code get it from here: ISO 3166-1
// alpha-2 (Walmart's "CN - China") and alpha-3 (Lowe's "CHN").
// [alpha-2, alpha-3, name] — UN members plus Hong Kong, Macau, Taiwan,
// Kosovo, Palestine, Puerto Rico and Vatican City.
const TABLE = [
  ['AF', 'AFG', 'Afghanistan'], ['AL', 'ALB', 'Albania'], ['DZ', 'DZA', 'Algeria'], ['AD', 'AND', 'Andorra'],
  ['AO', 'AGO', 'Angola'], ['AG', 'ATG', 'Antigua and Barbuda'], ['AR', 'ARG', 'Argentina'], ['AM', 'ARM', 'Armenia'],
  ['AU', 'AUS', 'Australia'], ['AT', 'AUT', 'Austria'], ['AZ', 'AZE', 'Azerbaijan'], ['BS', 'BHS', 'Bahamas'],
  ['BH', 'BHR', 'Bahrain'], ['BD', 'BGD', 'Bangladesh'], ['BB', 'BRB', 'Barbados'], ['BY', 'BLR', 'Belarus'],
  ['BE', 'BEL', 'Belgium'], ['BZ', 'BLZ', 'Belize'], ['BJ', 'BEN', 'Benin'], ['BT', 'BTN', 'Bhutan'],
  ['BO', 'BOL', 'Bolivia'], ['BA', 'BIH', 'Bosnia and Herzegovina'], ['BW', 'BWA', 'Botswana'], ['BR', 'BRA', 'Brazil'],
  ['BN', 'BRN', 'Brunei'], ['BG', 'BGR', 'Bulgaria'], ['BF', 'BFA', 'Burkina Faso'], ['BI', 'BDI', 'Burundi'],
  ['KH', 'KHM', 'Cambodia'], ['CM', 'CMR', 'Cameroon'], ['CA', 'CAN', 'Canada'], ['CV', 'CPV', 'Cape Verde'],
  ['CF', 'CAF', 'Central African Republic'], ['TD', 'TCD', 'Chad'], ['CL', 'CHL', 'Chile'], ['CN', 'CHN', 'China'],
  ['CO', 'COL', 'Colombia'], ['KM', 'COM', 'Comoros'], ['CG', 'COG', 'Congo'], ['CR', 'CRI', 'Costa Rica'],
  ['HR', 'HRV', 'Croatia'], ['CU', 'CUB', 'Cuba'], ['CY', 'CYP', 'Cyprus'], ['CZ', 'CZE', 'Czech Republic'],
  ['CD', 'COD', 'Democratic Republic of the Congo'], ['DK', 'DNK', 'Denmark'], ['DJ', 'DJI', 'Djibouti'], ['DM', 'DMA', 'Dominica'],
  ['DO', 'DOM', 'Dominican Republic'], ['EC', 'ECU', 'Ecuador'], ['EG', 'EGY', 'Egypt'], ['SV', 'SLV', 'El Salvador'],
  ['GQ', 'GNQ', 'Equatorial Guinea'], ['ER', 'ERI', 'Eritrea'], ['EE', 'EST', 'Estonia'], ['SZ', 'SWZ', 'Eswatini'],
  ['ET', 'ETH', 'Ethiopia'], ['FJ', 'FJI', 'Fiji'], ['FI', 'FIN', 'Finland'], ['FR', 'FRA', 'France'],
  ['GA', 'GAB', 'Gabon'], ['GM', 'GMB', 'Gambia'], ['GE', 'GEO', 'Georgia'], ['DE', 'DEU', 'Germany'],
  ['GH', 'GHA', 'Ghana'], ['GR', 'GRC', 'Greece'], ['GD', 'GRD', 'Grenada'], ['GT', 'GTM', 'Guatemala'],
  ['GN', 'GIN', 'Guinea'], ['GW', 'GNB', 'Guinea-Bissau'], ['GY', 'GUY', 'Guyana'], ['HT', 'HTI', 'Haiti'],
  ['HN', 'HND', 'Honduras'], ['HK', 'HKG', 'Hong Kong'], ['HU', 'HUN', 'Hungary'], ['IS', 'ISL', 'Iceland'],
  ['IN', 'IND', 'India'], ['ID', 'IDN', 'Indonesia'], ['IR', 'IRN', 'Iran'], ['IQ', 'IRQ', 'Iraq'],
  ['IE', 'IRL', 'Ireland'], ['IL', 'ISR', 'Israel'], ['IT', 'ITA', 'Italy'], ['CI', 'CIV', 'Ivory Coast'],
  ['JM', 'JAM', 'Jamaica'], ['JP', 'JPN', 'Japan'], ['JO', 'JOR', 'Jordan'], ['KZ', 'KAZ', 'Kazakhstan'],
  ['KE', 'KEN', 'Kenya'], ['KI', 'KIR', 'Kiribati'], ['XK', 'XKX', 'Kosovo'], ['KW', 'KWT', 'Kuwait'],
  ['KG', 'KGZ', 'Kyrgyzstan'], ['LA', 'LAO', 'Laos'], ['LV', 'LVA', 'Latvia'], ['LB', 'LBN', 'Lebanon'],
  ['LS', 'LSO', 'Lesotho'], ['LR', 'LBR', 'Liberia'], ['LY', 'LBY', 'Libya'], ['LI', 'LIE', 'Liechtenstein'],
  ['LT', 'LTU', 'Lithuania'], ['LU', 'LUX', 'Luxembourg'], ['MO', 'MAC', 'Macau'], ['MG', 'MDG', 'Madagascar'],
  ['MW', 'MWI', 'Malawi'], ['MY', 'MYS', 'Malaysia'], ['MV', 'MDV', 'Maldives'], ['ML', 'MLI', 'Mali'],
  ['MT', 'MLT', 'Malta'], ['MH', 'MHL', 'Marshall Islands'], ['MR', 'MRT', 'Mauritania'], ['MU', 'MUS', 'Mauritius'],
  ['MX', 'MEX', 'Mexico'], ['FM', 'FSM', 'Micronesia'], ['MD', 'MDA', 'Moldova'], ['MC', 'MCO', 'Monaco'],
  ['MN', 'MNG', 'Mongolia'], ['ME', 'MNE', 'Montenegro'], ['MA', 'MAR', 'Morocco'], ['MZ', 'MOZ', 'Mozambique'],
  ['MM', 'MMR', 'Myanmar'], ['NA', 'NAM', 'Namibia'], ['NR', 'NRU', 'Nauru'], ['NP', 'NPL', 'Nepal'],
  ['NL', 'NLD', 'Netherlands'], ['NZ', 'NZL', 'New Zealand'], ['NI', 'NIC', 'Nicaragua'], ['NE', 'NER', 'Niger'],
  ['NG', 'NGA', 'Nigeria'], ['KP', 'PRK', 'North Korea'], ['MK', 'MKD', 'North Macedonia'], ['NO', 'NOR', 'Norway'],
  ['OM', 'OMN', 'Oman'], ['PK', 'PAK', 'Pakistan'], ['PW', 'PLW', 'Palau'], ['PS', 'PSE', 'Palestine'],
  ['PA', 'PAN', 'Panama'], ['PG', 'PNG', 'Papua New Guinea'], ['PY', 'PRY', 'Paraguay'], ['PE', 'PER', 'Peru'],
  ['PH', 'PHL', 'Philippines'], ['PL', 'POL', 'Poland'], ['PT', 'PRT', 'Portugal'], ['PR', 'PRI', 'Puerto Rico'],
  ['QA', 'QAT', 'Qatar'], ['RO', 'ROU', 'Romania'], ['RU', 'RUS', 'Russia'], ['RW', 'RWA', 'Rwanda'],
  ['KN', 'KNA', 'Saint Kitts and Nevis'], ['LC', 'LCA', 'Saint Lucia'], ['VC', 'VCT', 'Saint Vincent and the Grenadines'], ['WS', 'WSM', 'Samoa'],
  ['SM', 'SMR', 'San Marino'], ['ST', 'STP', 'Sao Tome and Principe'], ['SA', 'SAU', 'Saudi Arabia'], ['SN', 'SEN', 'Senegal'],
  ['RS', 'SRB', 'Serbia'], ['SC', 'SYC', 'Seychelles'], ['SL', 'SLE', 'Sierra Leone'], ['SG', 'SGP', 'Singapore'],
  ['SK', 'SVK', 'Slovakia'], ['SI', 'SVN', 'Slovenia'], ['SB', 'SLB', 'Solomon Islands'], ['SO', 'SOM', 'Somalia'],
  ['ZA', 'ZAF', 'South Africa'], ['KR', 'KOR', 'South Korea'], ['SS', 'SSD', 'South Sudan'], ['ES', 'ESP', 'Spain'],
  ['LK', 'LKA', 'Sri Lanka'], ['SD', 'SDN', 'Sudan'], ['SR', 'SUR', 'Suriname'], ['SE', 'SWE', 'Sweden'],
  ['CH', 'CHE', 'Switzerland'], ['SY', 'SYR', 'Syria'], ['TW', 'TWN', 'Taiwan'], ['TJ', 'TJK', 'Tajikistan'],
  ['TZ', 'TZA', 'Tanzania'], ['TH', 'THA', 'Thailand'], ['TL', 'TLS', 'Timor-Leste'], ['TG', 'TGO', 'Togo'],
  ['TO', 'TON', 'Tonga'], ['TT', 'TTO', 'Trinidad and Tobago'], ['TN', 'TUN', 'Tunisia'], ['TR', 'TUR', 'Turkey'],
  ['TM', 'TKM', 'Turkmenistan'], ['TV', 'TUV', 'Tuvalu'], ['UG', 'UGA', 'Uganda'], ['UA', 'UKR', 'Ukraine'],
  ['AE', 'ARE', 'United Arab Emirates'], ['GB', 'GBR', 'United Kingdom'], ['US', 'USA', 'United States'], ['UY', 'URY', 'Uruguay'],
  ['UZ', 'UZB', 'Uzbekistan'], ['VU', 'VUT', 'Vanuatu'], ['VA', 'VAT', 'Vatican City'], ['VE', 'VEN', 'Venezuela'],
  ['VN', 'VNM', 'Vietnam'], ['YE', 'YEM', 'Yemen'], ['ZM', 'ZMB', 'Zambia'], ['ZW', 'ZWE', 'Zimbabwe'],
];

export const COUNTRIES = TABLE.map(([code, code3, name]) => ({ code, code3, name }));

/** The dropdown's options, alphabetical by name. */
export const COUNTRY_NAMES = COUNTRIES.map((c) => c.name);
export const COUNTRY_OPTIONS = COUNTRIES.map((c) => ({ value: c.name, label: c.name }));

// Other spellings files and marketplaces use for the same country.
const ALIASES = {
  usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB',
  'viet nam': 'VN',
  prc: 'CN', "people's republic of china": 'CN', 'mainland china': 'CN',
  korea: 'KR', 'republic of korea': 'KR', 'korea, south': 'KR', 'korea, republic of': 'KR',
  czechia: 'CZ', turkiye: 'TR', 'türkiye': 'TR', holland: 'NL', 'russian federation': 'RU',
  'cabo verde': 'CV', "cote d'ivoire": 'CI', "côte d'ivoire": 'CI', swaziland: 'SZ', macedonia: 'MK',
  burma: 'MM', macao: 'MO', 'east timor': 'TL', 'brunei darussalam': 'BN', "lao people's democratic republic": 'LA',
  'republic of moldova': 'MD', 'vatican city state': 'VA', 'holy see': 'VA', 'state of palestine': 'PS',
  drc: 'CD', 'dr congo': 'CD', 'congo (kinshasa)': 'CD', 'congo (brazzaville)': 'CG', 'republic of the congo': 'CG',
};

const BY_NAME = new Map();
for (const c of COUNTRIES) BY_NAME.set(c.name.toLowerCase(), c);
for (const [alias, code] of Object.entries(ALIASES)) BY_NAME.set(alias, COUNTRIES.find((c) => c.code === code));
// Codes count only written in capitals ("CN", "VNM"): "no", "Is" or "NA"
// in a file mean "none" / "not available", never Norway or Namibia
// (those two take their name or NOR / NAM).
const BY_CODE = new Map();
for (const c of COUNTRIES) {
  if (c.code !== 'NA' && c.code !== 'NO') BY_CODE.set(c.code, c);
  BY_CODE.set(c.code3, c);
}

/** 'CN' / 'china' / 'Made in Viet Nam' → the country's entry; anything else → null. */
export function findCountry(value) {
  const text = String(value ?? '').trim().replace(/^made in\s+/i, '').replace(/\s+/g, ' ');
  if (!text) return null;
  return BY_NAME.get(text.toLowerCase()) ?? BY_CODE.get(text) ?? null;
}

/** 'CN' → 'China', 'Viet Nam' → 'Vietnam'; unknown → null. */
export const canonicalCountry = (value) => findCountry(value)?.name ?? null;
