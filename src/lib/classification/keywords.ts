/**
 * Keyword analysis: lower-confidence classification for merchants we don't
 * explicitly know. Each rule matches words in the counterparty/narration.
 * Confidence is intentionally capped (< known-merchant confidence).
 */
export interface KeywordRule {
  pattern: RegExp;
  category: string;
  subcategory: string;
  confidence: number;
  /** Only apply to this direction. */
  direction?: "debit" | "credit";
}

const K = (
  pattern: string,
  category: string,
  subcategory: string,
  confidence = 0.7,
  direction?: "debit" | "credit",
): KeywordRule => ({ pattern: new RegExp(pattern, "i"), category, subcategory, confidence, direction });

export const KEYWORD_RULES: KeywordRule[] = [
  // Food
  K("RESTAURANT|RESTAURANTS|DHABA|BIRYANI|KITCHEN|EATERY|BISTRO|\\bGRILL\\b|TANDOOR|MESS\\b", "FOOD", "Restaurants", 0.72, "debit"),
  K("\\bCAFE\\b|COFFEE|\\bTEA\\b|CHAI|ESPRESSO", "FOOD", "Cafes", 0.7, "debit"),
  K("BAKERY|BAKERS|SWEETS|SWEET\\s*HOUSE|ICE\\s*CREAM|DESSERT|JUICE", "FOOD", "Bakery & Sweets", 0.7, "debit"),
  K("PIZZA|BURGER|FAST\\s*FOOD|FRIED\\s*CHICKEN|SANDWICH|SHAWARMA|MOMO", "FOOD", "Fast Food", 0.7, "debit"),
  K("\\bFOODS?\\b|FOOD\\s*COURT|CATERING", "FOOD", "Restaurants", 0.6, "debit"),
  // Groceries
  K("SUPERMARKET|SUPER\\s*MARKET|KIRANA|GROCER|PROVISION|GENERAL\\s*STORES?|HYPERMARKET", "GROCERIES", "Supermarket", 0.72, "debit"),
  K("VEGETABLE|FRUITS?\\b|FRESH\\b|\\bSABZI|DAIRY|MILK", "GROCERIES", "Fresh Produce", 0.68, "debit"),
  // Transport
  K("PETROL|FUEL|FILLING\\s*STATION|\\bBUNK\\b|GAS\\s*STATION|\\bCNG\\b", "TRANSPORTATION", "Fuel", 0.78, "debit"),
  K("PARKING", "TRANSPORTATION", "Parking", 0.8, "debit"),
  K("\\bCAB\\b|TAXI|\\bRIDE\\b", "TRANSPORTATION", "Cab", 0.65, "debit"),
  K("\\bMETRO\\b", "TRANSPORTATION", "Metro", 0.68, "debit"),
  K("AUTO\\s*(SERVICE|GARAGE|WORKS)|GARAGE|TYRE|CAR\\s*(WASH|CARE)|BIKE\\s*SERVICE", "TRANSPORTATION", "Vehicle Service", 0.7, "debit"),
  // Travel
  K("HOTEL|RESORT|LODGE|HOMESTAY|\\bINN\\b|GUEST\\s*HOUSE|STAYS?\\b", "TRAVEL", "Hotels", 0.7, "debit"),
  K("AIRLINES?|AIRWAYS|FLIGHT|AIRPORT", "TRAVEL", "Flights", 0.72, "debit"),
  K("TRAVELS|TOURS?\\b|HOLIDAYS?|TRAVEL\\s*AGENCY", "TRAVEL", "Travel Booking", 0.62, "debit"),
  // Healthcare
  K("PHARMACY|PHARMA\\b|CHEMIST|MEDICAL\\s*STORE|MEDICALS?\\b|DRUG", "HEALTHCARE", "Pharmacy", 0.78, "debit"),
  K("HOSPITAL|NURSING\\s*HOME", "HEALTHCARE", "Hospital", 0.8, "debit"),
  K("CLINIC|DR\\.?\\s|DENTAL|DENTIST|PHYSIO|EYE\\s*CARE|OPTICAL", "HEALTHCARE", "Doctor", 0.72, "debit"),
  K("DIAGNOSTIC|PATH\\s*LAB|\\bLABS?\\b|SCAN\\s*CENTRE", "HEALTHCARE", "Diagnostics", 0.72, "debit"),
  // Education
  K("SCHOOL|COLLEGE|UNIVERSITY|TUITION|COACHING|\\bCLASSES\\b|TUTORIAL|ACADEMY|INSTITUTE|\\bFEES?\\b\\s*(PAYMENT|COLLECTION)?", "EDUCATION", "College", 0.66, "debit"),
  K("BOOK\\s*(STORE|SHOP|HOUSE)|BOOKS\\b|STATIONER|LIBRARY", "EDUCATION", "Books", 0.68, "debit"),
  K("COURSE|CERTIFICATION|EXAM\\s*FEE|LEARNING|UPSKILL", "EDUCATION", "Courses", 0.68, "debit"),
  // Entertainment
  K("CINEMA|MOVIE|MULTIPLEX|THEATRE|THEATER", "ENTERTAINMENT", "Movies", 0.75, "debit"),
  K("GAMING|\\bGAMES?\\b|ESPORTS|PLAYSTORE", "ENTERTAINMENT", "Games", 0.65, "debit"),
  K("CONCERT|FESTIVAL|EVENTS?\\b|TICKETS?\\b|AMUSEMENT|WATER\\s*PARK", "ENTERTAINMENT", "Events", 0.62, "debit"),
  K("STREAMING|\\bOTT\\b", "ENTERTAINMENT", "Streaming", 0.7, "debit"),
  // Utilities & bills
  K("ELECTRIC|POWER\\s*BILL|ELECTRICITY|\\bEB\\s*BILL", "UTILITIES", "Electricity", 0.8, "debit"),
  K("BROADBAND|FIBER|FIBRE|\\bWIFI\\b|INTERNET", "UTILITIES", "Internet", 0.78, "debit"),
  K("RECHARGE|PREPAID|POSTPAID|MOBILE\\s*BILL|TELECOM", "UTILITIES", "Mobile", 0.78, "debit"),
  K("WATER\\s*(BILL|CHARGES|TAX)", "UTILITIES", "Water", 0.8, "debit"),
  K("\\bGAS\\s*(BILL|CYLINDER|AGENCY)|CYLINDER", "UTILITIES", "Gas", 0.75, "debit"),
  K("\\bDTH\\b|CABLE\\s*TV", "UTILITIES", "DTH & Cable", 0.75, "debit"),
  K("INSURANCE|PREMIUM|POLICY", "BILLS", "Insurance", 0.78, "debit"),
  K("LOAN|\\bEMI\\b|HOUSING\\s*FINANCE|FINSERV|BAJAJ\\s*FIN", "BILLS", "Loan EMI", 0.75, "debit"),
  K("CREDIT\\s*CARD|\\bCC\\s*(BILL|PAYMENT)|CARD\\s*PAYMENT|BILLDESK.*CARD", "BILLS", "Credit Card Bill", 0.8, "debit"),
  K("MUNICIPAL|CORPORATION|GOVT|GOVERNMENT|\\bRTO\\b|CHALLAN|PASSPORT|STAMP\\s*DUTY|\\bTAX\\b", "BILLS", "Government", 0.68, "debit"),
  // Rent
  K("\\bRENT\\b|LANDLORD|HOUSE\\s*RENT|\\bPG\\b|HOSTEL", "RENT", "Rent", 0.85, "debit"),
  K("MAINTENANCE|SOCIETY|APARTMENT\\s*ASSOC", "RENT", "Maintenance", 0.7, "debit"),
  // Shopping
  K("FASHION|APPAREL|CLOTH|GARMENT|BOUTIQUE|TEXTILE|SAREE|FOOTWEAR|SHOES?", "SHOPPING", "Clothing", 0.7, "debit"),
  K("ELECTRONICS?|MOBILES?\\s*(STORE|SHOP|WORLD)|GADGET|COMPUTER|LAPTOP", "SHOPPING", "Electronics", 0.7, "debit"),
  K("FURNITURE|HOME\\s*(DECOR|STORE|NEEDS)|HARDWARE|INTERIOR", "SHOPPING", "Home & Furniture", 0.68, "debit"),
  K("\\bSTORES?\\b|\\bMART\\b|\\bSHOP\\b|RETAIL|\\bBAZAAR|TRADERS|ENTERPRISES?", "SHOPPING", "General Retail", 0.55, "debit"),
  // Personal
  K("SALON|PARLOUR|PARLOR|BARBER|\\bSPA\\b|GROOMING|BEAUTY|COSMETIC", "PERSONAL", "Salon & Grooming", 0.75, "debit"),
  K("\\bGYM\\b|FITNESS|YOGA|CROSSFIT|SPORTS\\s*CLUB", "PERSONAL", "Fitness", 0.75, "debit"),
  K("DONATION|CHARITY|TEMPLE|TRUST\\b|FOUNDATION|NGO", "PERSONAL", "Gifts & Donations", 0.7, "debit"),
  K("PET\\s*(SHOP|STORE|CARE)|VETERINARY|\\bVET\\b", "PERSONAL", "Pets", 0.75, "debit"),
  // Investments
  K("MUTUAL\\s*FUND|\\bSIP\\b|\\bMF\\b|AMC\\b", "INVESTMENTS", "Mutual Funds", 0.8, "debit"),
  K("BROKING|SECURITIES|DEMAT|STOCK", "INVESTMENTS", "Stocks", 0.72, "debit"),
  // Income (credits)
  K("SALARY|PAYROLL|\\bSAL\\b|WAGES", "SALARY/INCOME", "Salary", 0.9, "credit"),
  K("INTEREST|\\bINT\\.?\\s*PD", "SALARY/INCOME", "Interest", 0.85, "credit"),
  K("DIVIDEND", "SALARY/INCOME", "Dividend", 0.9, "credit"),
  K("FREELANCE|CONSULT|INVOICE|PROFESSIONAL\\s*FEES?", "SALARY/INCOME", "Freelance & Business", 0.7, "credit"),
  K("REFUND|REVERSAL|REVERSED|CASHBACK|CASH\\s*BACK|CHARGEBACK", "REFUNDS", "Refund", 0.88, "credit"),
  K("REIMBURS", "SALARY/INCOME", "Other Income", 0.7, "credit"),
];

export function matchKeywords(text: string, direction: "debit" | "credit"): KeywordRule | undefined {
  const t = text.toUpperCase();
  let best: KeywordRule | undefined;
  for (const r of KEYWORD_RULES) {
    if (r.direction && r.direction !== direction) continue;
    if (!r.pattern.test(t)) continue;
    if (!best || r.confidence > best.confidence) best = r;
  }
  return best;
}
