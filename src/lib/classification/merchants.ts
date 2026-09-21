/**
 * Merchant intelligence. Kept deliberately separate from categorisation so
 * analytics can group by merchant even when the category is corrected later.
 *
 *   raw narration -> counterparty token -> canonical merchant (+ known category)
 */
import type { TxnType } from "../parsers/hdfc/normalizer";
import { isGatewayName } from "../parsers/hdfc/upi";

export interface KnownMerchant {
  name: string;
  pattern: RegExp;
  category: string;
  subcategory: string;
  confidence: number;
}

const M = (name: string, pattern: string, category: string, subcategory: string, confidence = 0.96): KnownMerchant => ({
  name,
  pattern: new RegExp(pattern, "i"),
  category,
  subcategory,
  confidence,
});

/** Order matters: more specific entries first. */
export const KNOWN_MERCHANTS: KnownMerchant[] = [
  // Food delivery & dining
  M("Swiggy Instamart", "SWIGGY\\s*INSTAMART|INSTAMART", "GROCERIES", "Quick Commerce", 0.85),
  M("Swiggy", "\\bSWIGGY|\\bBUNDL\\s*TECH", "FOOD", "Food Delivery", 0.9), // Bundl Technologies is Swiggy's legal entity
  M("Juice Cafe", "JUICE\\s*CAFE", "FOOD", "Cafes", 0.82),
  M("Zomato", "\\bZOMATO", "FOOD", "Food Delivery", 0.98),
  M("EatSure", "EATSURE|EAT\\s*SURE", "FOOD", "Food Delivery"),
  M("Starbucks", "STARBUCKS", "FOOD", "Cafes"),
  M("Cafe Coffee Day", "CAFE\\s*COFFEE\\s*DAY|\\bCCD\\b", "FOOD", "Cafes"),
  M("Third Wave Coffee", "THIRD\\s*WAVE", "FOOD", "Cafes"),
  M("Chaayos", "CHAAYOS", "FOOD", "Cafes"),
  M("Blue Tokai", "BLUE\\s*TOKAI", "FOOD", "Cafes"),
  M("Domino's", "DOMINO", "FOOD", "Fast Food"),
  M("McDonald's", "MCDONALD|MC\\s*DONALD", "FOOD", "Fast Food"),
  M("KFC", "\\bKFC\\b", "FOOD", "Fast Food"),
  M("Burger King", "BURGER\\s*KING", "FOOD", "Fast Food"),
  M("Pizza Hut", "PIZZA\\s*HUT", "FOOD", "Fast Food"),
  M("Subway", "\\bSUBWAY\\b", "FOOD", "Fast Food"),
  M("Haldiram's", "HALDIRAM", "FOOD", "Bakery & Sweets"),
  M("Barbeque Nation", "BARBEQUE\\s*NATION", "FOOD", "Restaurants"),
  // Groceries
  // Quick-commerce apps sell far more than groceries, so confidence is deliberately modest.
  M("Blinkit", "\\bBLINKIT|GROFERS", "GROCERIES", "Quick Commerce", 0.75),
  M("Zepto", "\\bZEPTO", "GROCERIES", "Quick Commerce", 0.75),
  M("Big Save", "BIG\\s*SAVE|BIGSAVE", "GROCERIES", "Supermarket", 0.7),
  M("BigBasket", "BIG\\s*BASKET|BIGBASKET", "GROCERIES", "Online Grocery", 0.98),
  M("DMart", "\\bD\\s?MART|AVENUE\\s*SUPERMARTS", "GROCERIES", "Supermarket", 0.97),
  M("Reliance Smart", "RELIANCE\\s*(SMART|FRESH|RETAIL)", "GROCERIES", "Supermarket"),
  M("More Supermarket", "MORE\\s*(SUPERMARKET|RETAIL)|\\bMORE\\s*MEGASTORE", "GROCERIES", "Supermarket", 0.9),
  M("Nature's Basket", "NATURE.?S\\s*BASKET", "GROCERIES", "Supermarket"),
  M("JioMart", "JIO\\s*MART|JIOMART", "GROCERIES", "Online Grocery"),
  M("Country Delight", "COUNTRY\\s*DELIGHT", "GROCERIES", "Online Grocery"),
  // Transport
  M("Uber", "\\bUBER", "TRANSPORTATION", "Cab", 0.97),
  M("Ola", "\\bOLA\\s*(CABS|MONEY|ELECTRIC)?\\b|OLACABS", "TRANSPORTATION", "Cab", 0.93),
  M("Rapido", "RAPIDO", "TRANSPORTATION", "Cab"),
  M("Namma Yatri", "NAMMA\\s*YATRI", "TRANSPORTATION", "Cab"),
  M("Indian Oil", "INDIAN\\s*OIL|IOCL|\\bINDIANOIL", "TRANSPORTATION", "Fuel"),
  M("Bharat Petroleum", "BHARAT\\s*PETROLEUM|\\bBPCL", "TRANSPORTATION", "Fuel"),
  M("HP Petrol Pump", "HINDUSTAN\\s*PETROLEUM|\\bHPCL|\\bHP\\s*PETROL", "TRANSPORTATION", "Fuel"),
  M("Shell", "\\bSHELL\\b", "TRANSPORTATION", "Fuel", 0.9),
  M("FASTag", "FASTAG|NETC|\\bTOLL", "TRANSPORTATION", "Toll"),
  M("Delhi Metro", "\\bDMRC|DELHI\\s*METRO", "TRANSPORTATION", "Metro"),
  M("Namma Metro", "\\bBMRC|NAMMA\\s*METRO|BANGALORE\\s*METRO", "TRANSPORTATION", "Metro"),
  M("Mumbai Metro", "MMRC|MUMBAI\\s*METRO|MMOPL", "TRANSPORTATION", "Metro"),
  M("BMTC", "\\bBMTC|\\bKSRTC|\\bMSRTC|\\bTSRTC", "TRANSPORTATION", "Bus"),
  // Travel
  M("IRCTC", "IRCTC", "TRAVEL", "Trains & Buses", 0.98),
  M("RedBus", "REDBUS", "TRAVEL", "Trains & Buses"),
  M("MakeMyTrip", "MAKE\\s*MY\\s*TRIP|MAKEMYTRIP|\\bMMT", "TRAVEL", "Travel Booking", 0.95),
  M("Goibibo", "GOIBIBO", "TRAVEL", "Travel Booking"),
  M("Cleartrip", "CLEARTRIP", "TRAVEL", "Travel Booking"),
  M("Yatra", "\\bYATRA\\b", "TRAVEL", "Travel Booking", 0.9),
  M("IndiGo", "INDIGO|INTERGLOBE", "TRAVEL", "Flights"),
  M("Air India", "AIR\\s*INDIA", "TRAVEL", "Flights"),
  M("Vistara", "VISTARA", "TRAVEL", "Flights"),
  M("Akasa Air", "AKASA", "TRAVEL", "Flights"),
  M("Airbnb", "AIRBNB", "TRAVEL", "Hotels"),
  M("OYO", "\\bOYO\\b", "TRAVEL", "Hotels"),
  M("Taj Hotels", "TAJ\\s*(HOTELS|MAHAL)|\\bIHCL", "TRAVEL", "Hotels", 0.9),
  // Shopping
  M("Amazon", "AMAZON|AMZN", "SHOPPING", "Online Shopping", 0.93),
  M("Flipkart", "FLIPKART", "SHOPPING", "Online Shopping", 0.96),
  M("Myntra", "MYNTRA", "SHOPPING", "Clothing", 0.96),
  M("Ajio", "\\bAJIO\\b", "SHOPPING", "Clothing"),
  M("Zara", "\\bZARA\\b", "SHOPPING", "Clothing"),
  M("H&M", "\\bH\\s?&\\s?M\\b|HENNES", "SHOPPING", "Clothing"),
  M("Uniqlo", "UNIQLO", "SHOPPING", "Clothing"),
  M("Nykaa", "NYKAA", "SHOPPING", "Online Shopping", 0.94),
  M("Meesho", "MEESHO", "SHOPPING", "Online Shopping"),
  M("Croma", "\\bCROMA", "SHOPPING", "Electronics"),
  M("Reliance Digital", "RELIANCE\\s*DIGITAL", "SHOPPING", "Electronics"),
  M("Apple", "\\bAPPLE\\b(?!\\s*MUSIC)|APPLE\\s*STORE", "SHOPPING", "Electronics", 0.85),
  M("IKEA", "\\bIKEA\\b", "SHOPPING", "Home & Furniture"),
  M("Pepperfry", "PEPPERFRY", "SHOPPING", "Home & Furniture"),
  M("Decathlon", "DECATHLON", "SHOPPING", "General Retail"),
  // Entertainment
  M("BookMyShow", "BOOK\\s*MY\\s*SHOW|BOOKMYSHOW", "ENTERTAINMENT", "Movies", 0.97),
  M("PVR INOX", "\\bPVR|\\bINOX", "ENTERTAINMENT", "Movies"),
  M("Netflix", "NETFLIX", "ENTERTAINMENT", "Streaming", 0.98),
  M("Amazon Prime", "PRIME\\s*VIDEO|AMAZON\\s*PRIME|AMZNPRIME", "ENTERTAINMENT", "Streaming", 0.96),
  M("Disney+ Hotstar", "HOTSTAR|DISNEY", "ENTERTAINMENT", "Streaming", 0.97),
  M("Spotify", "SPOTIFY", "ENTERTAINMENT", "Streaming", 0.98),
  M("YouTube Premium", "YOUTUBE|GOOGLE\\s*YOUTUBE", "ENTERTAINMENT", "Streaming", 0.95),
  M("SonyLIV", "SONY\\s*LIV|SONYLIV", "ENTERTAINMENT", "Streaming"),
  M("ZEE5", "\\bZEE5", "ENTERTAINMENT", "Streaming"),
  M("JioCinema", "JIO\\s*CINEMA|JIOCINEMA", "ENTERTAINMENT", "Streaming"),
  M("Steam", "\\bSTEAM(\\s*GAMES|POWERED)?\\b", "ENTERTAINMENT", "Games", 0.9),
  M("PlayStation", "PLAYSTATION|SONY\\s*INTERACTIVE", "ENTERTAINMENT", "Games"),
  M("Google Play", "GOOGLE\\s*PLAY|PLAY\\s*STORE", "ENTERTAINMENT", "Digital Purchases", 0.8),
  M("Paytm Insider", "PAYTM\\s*INSIDER|INSIDER\\.IN", "ENTERTAINMENT", "Events"),
  // Education
  M("Unstop", "UNSTOP", "EDUCATION", "Career & Events", 0.75),
  M("Udemy", "UDEMY", "EDUCATION", "Courses", 0.97),
  M("Coursera", "COURSERA", "EDUCATION", "Courses", 0.97),
  M("Unacademy", "UNACADEMY", "EDUCATION", "Courses"),
  M("upGrad", "UPGRAD", "EDUCATION", "Courses"),
  M("Simplilearn", "SIMPLILEARN", "EDUCATION", "Certifications"),
  M("edX", "\\bEDX\\b", "EDUCATION", "Courses"),
  M("Physics Wallah", "PHYSICS\\s*WALLAH|\\bPW\\b\\s*(PAY|LTD)|PHYSICSWALLAH", "EDUCATION", "Courses"),
  M("BYJU'S", "BYJU", "EDUCATION", "Courses"),
  M("LinkedIn Learning", "LINKEDIN", "EDUCATION", "Educational Subscriptions", 0.85),
  M("Skillshare", "SKILLSHARE", "EDUCATION", "Educational Subscriptions"),
  M("Pluralsight", "PLURALSIGHT", "EDUCATION", "Educational Subscriptions"),
  M("Kindle / Audible", "KINDLE|AUDIBLE", "EDUCATION", "Books", 0.85),
  // Subscriptions & software
  M("OpenAI", "OPENAI|CHATGPT", "SUBSCRIPTIONS", "Software"),
  M("Anthropic", "ANTHROPIC|CLAUDE\\.AI", "SUBSCRIPTIONS", "Software"),
  M("GitHub", "GITHUB", "SUBSCRIPTIONS", "Software"),
  M("Microsoft", "MICROSOFT|MSFT|OFFICE\\s*365", "SUBSCRIPTIONS", "Software", 0.9),
  M("Adobe", "\\bADOBE", "SUBSCRIPTIONS", "Software"),
  M("Notion", "\\bNOTION\\b", "SUBSCRIPTIONS", "Software"),
  M("Dropbox", "DROPBOX", "SUBSCRIPTIONS", "Cloud & Storage"),
  M("Google One", "GOOGLE\\s*(ONE|STORAGE|CLOUD)", "SUBSCRIPTIONS", "Cloud & Storage"),
  M("Google", "GOOGLE\\s*(INDIA|ASIA|IRELAND|ADS)", "ENTERTAINMENT", "Digital Purchases", 0.6), // ambiguous: Play / YouTube / Ads
  M("iCloud", "ICLOUD", "SUBSCRIPTIONS", "Cloud & Storage"),
  M("Cult.fit", "CULT\\s*\\.?\\s*FIT|CULTFIT", "PERSONAL", "Fitness", 0.95),
  M("The Hindu / Times", "THE\\s*HINDU|TIMES\\s*OF\\s*INDIA|TIMESPRIME", "SUBSCRIPTIONS", "News & Media"),
  // Utilities
  M("Jio", "\\bJIO\\b(?!\\s*(MART|CINEMA))|RELIANCE\\s*JIO|JIOPREPAID|JIO\\s*PREPAID|JIOFIBER", "UTILITIES", "Mobile", 0.95),
  M("Airtel", "\\bAIRTEL|BHARTI\\s*AIRTEL", "UTILITIES", "Mobile", 0.94),
  M("Vi (Vodafone Idea)", "VODAFONE|IDEA\\s*CELLULAR|\\bVI\\s*(PREPAID|POSTPAID)", "UTILITIES", "Mobile"),
  M("BSNL", "\\bBSNL", "UTILITIES", "Mobile"),
  M("ACT Fibernet", "\\bACT\\s*FIBER|ACT\\s*BROADBAND|ACTFIBERNET", "UTILITIES", "Internet", 0.97),
  M("Hathway", "HATHWAY", "UTILITIES", "Internet"),
  M("Tata Play", "TATA\\s*(PLAY|SKY)", "UTILITIES", "DTH & Cable"),
  M("Dish TV", "DISH\\s*TV|D2H", "UTILITIES", "DTH & Cable"),
  M("BESCOM", "\\bBESCOM", "UTILITIES", "Electricity", 0.98),
  M("MSEDCL", "MSEDCL|MAHAVITARAN|MSEB", "UTILITIES", "Electricity"),
  M("Adani Electricity", "ADANI\\s*ELECTRICITY", "UTILITIES", "Electricity"),
  M("Tata Power", "TATA\\s*POWER", "UTILITIES", "Electricity"),
  M("BSES", "\\bBSES\\b", "UTILITIES", "Electricity"),
  M("Electricity Board", "ELECTRICITY|\\bPOWER\\s*(CORP|SUPPLY|DISTRIBUTION)|\\bDISCOM", "UTILITIES", "Electricity", 0.85),
  M("Water Board", "WATER\\s*(BOARD|SUPPLY|BILL)|\\bBWSSB|JAL\\s*BOARD", "UTILITIES", "Water"),
  M("Indane Gas", "INDANE|\\bHP\\s*GAS|BHARATGAS|BHARAT\\s*GAS|LPG", "UTILITIES", "Gas"),
  M("Mahanagar Gas", "MAHANAGAR\\s*GAS|\\bMGL\\b|INDRAPRASTHA\\s*GAS|\\bIGL\\b", "UTILITIES", "Gas"),
  // Healthcare
  M("Apollo Pharmacy", "APOLLO\\s*PHARM|APOLLO247|APOLLO\\s*24", "HEALTHCARE", "Pharmacy", 0.97),
  M("PharmEasy", "PHARMEASY", "HEALTHCARE", "Pharmacy"),
  M("1mg", "\\b1\\s?MG\\b|TATA\\s*1MG", "HEALTHCARE", "Pharmacy"),
  M("Netmeds", "NETMEDS", "HEALTHCARE", "Pharmacy"),
  M("MedPlus", "MEDPLUS", "HEALTHCARE", "Pharmacy"),
  M("Practo", "PRACTO", "HEALTHCARE", "Doctor"),
  M("Apollo Hospitals", "APOLLO\\s*HOSP", "HEALTHCARE", "Hospital"),
  M("Dr Lal PathLabs", "LAL\\s*PATH|THYROCARE|METROPOLIS|SRL\\s*DIAG", "HEALTHCARE", "Diagnostics"),
  // Bills / insurance / govt
  M("LIC", "\\bLIC\\b|LIFE\\s*INSURANCE\\s*CORP", "BILLS", "Insurance"),
  M("HDFC Life", "HDFC\\s*LIFE", "BILLS", "Insurance"),
  M("ICICI Prudential", "ICICI\\s*PRU", "BILLS", "Insurance"),
  M("Star Health", "STAR\\s*HEALTH", "BILLS", "Insurance"),
  M("Digit Insurance", "DIGIT\\s*(GENERAL\\s*)?INSURANCE", "BILLS", "Insurance"),
  M("Acko", "\\bACKO\\b", "BILLS", "Insurance"),
  M("CRED", "\\bCRED\\b|CRED\\.CLUB|CREDCLUB", "BILLS", "Credit Card Bill", 0.9),
  M("Income Tax", "INCOME\\s*TAX|\\bCBDT|\\bTIN\\s*NSDL|ADVANCE\\s*TAX", "BILLS", "Taxes"),
  M("GST Payment", "\\bGSTN\\b|GST\\s*PAYMENT", "BILLS", "Taxes", 0.85),
  // Investments
  M("Zerodha", "ZERODHA|\\bKITE\\b|ZCC\\b", "INVESTMENTS", "Stocks", 0.97),
  M("Groww", "\\bGROWW", "INVESTMENTS", "Mutual Funds", 0.95),
  M("Upstox", "UPSTOX|RKSV", "INVESTMENTS", "Stocks"),
  M("Angel One", "ANGEL\\s*(ONE|BROKING)", "INVESTMENTS", "Stocks"),
  M("Kuvera", "KUVERA", "INVESTMENTS", "Mutual Funds"),
  M("INDmoney", "INDMONEY|IND\\s*MONEY", "INVESTMENTS", "Stocks"),
  M("Mutual Fund", "MUTUAL\\s*FUND|\\bSIP\\b|\\bBSE\\s*STAR|\\bNIPPON|\\bAXIS\\s*MF|SBI\\s*MF|HDFC\\s*AMC|\\bICICI\\s*PRU\\s*(AMC|MF)|MIRAE|PARAG\\s*PARIKH|\\bPPFAS|MOTILAL\\s*OSWAL\\s*(AMC|MF)|KOTAK\\s*MF|\\bCAMS\\b|KFINTECH", "INVESTMENTS", "Mutual Funds", 0.92),
  M("NPS", "\\bNPS\\b|PROTEAN|NATIONAL\\s*PENSION", "INVESTMENTS", "PPF & NPS"),
  M("PPF", "\\bPPF\\b|PUBLIC\\s*PROVIDENT", "INVESTMENTS", "PPF & NPS"),
  M("Fixed Deposit", "\\bFD\\b|FIXED\\s*DEPOSIT|\\bRD\\s*INSTALL|RECURRING\\s*DEPOSIT", "INVESTMENTS", "Fixed Deposit", 0.85),
  // Wallets
  M("Paytm Wallet", "PAYTM\\s*(WALLET|ADD|TOP)", "TRANSFERS", "Wallet Top-up", 0.85),
  M("PhonePe Wallet", "PHONEPE\\s*WALLET", "TRANSFERS", "Wallet Top-up", 0.85),
  M("Amazon Pay Balance", "AMAZON\\s*PAY\\s*(BALANCE|WALLET|ADD)", "TRANSFERS", "Wallet Top-up", 0.85),
  // Rent / maintenance platforms
  M("NoBroker", "NOBROKER|NO\\s*BROKER", "RENT", "Rent", 0.85),
  M("Society Maintenance", "MYGATE|NOBROKERHOOD|APARTMENT\\s*ADDA|SOCIETY\\s*MAINT|RWA\\b", "RENT", "Maintenance", 0.85),
];

const BUSINESS_WORDS =
  /\b(STORE|STORES|MART|SHOP|PVT|LTD|LIMITED|LLP|ENTERPRISE|ENTERPRISES|TRADERS|TRADING|SERVICES|RESTAURANT|CAFE|HOTEL|PHARMACY|MEDICAL|FOODS?|KITCHEN|BAKERS?|BAKERY|PAY|PAYMENTS?|TECH|TECHNOLOGIES|BANK|SUPER|MARKET|CENTRE|CENTER|CLINIC|HOSPITAL|COMPANY|CORP|INC|SOLUTIONS|SYSTEMS|INDUSTRIES|AGENCY|ASSOCIATES|SALON|GYM|FITNESS|TRAVELS|MOTORS|AUTO|FUELS|PETROL|GAS|ELECTRICALS|ELECTRONICS|FASHION|TEXTILES|BOOKS|STATIONERS|DAIRY|SWEETS|JUICE|TEA|COFFEE|BIRYANI|DHABA|PIZZA|BURGER|INSTITUTE|ACADEMY|SCHOOL|COLLEGE|UNIVERSITY|CLASSES|TUTORIALS|ONLINE|INDIA|GROUP|FINANCE|INSURANCE|LIFE|MUTUAL|FUND|BROKING|SECURITIES|CAPITAL|WALLET|RECHARGE|BILL|BILLS|UTILITIES|NETWORKS|TELECOM)\b/i;

const TITLES = /^(MR|MRS|MS|MISS|SHRI|SMT|SRI|DR|KUM)\.?\s+/i;

export function looksLikePerson(name?: string): { person: boolean; titled: boolean } {
  if (!name) return { person: false, titled: false };
  const n = name.trim();
  const titled = TITLES.test(n);
  const bare = n.replace(TITLES, "");
  if (/[\d@*_/]/.test(bare)) return { person: false, titled };
  if (BUSINESS_WORDS.test(bare)) return { person: false, titled };
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return { person: false, titled };
  if (!words.every((w) => /^[A-Za-z.'-]{2,}$/.test(w) || /^[A-Za-z]\.?$/.test(w))) return { person: false, titled };
  return { person: words.length >= 2 || titled, titled };
}

export function merchantKeyOf(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 40);
}

const SMALL = new Set(["and", "of", "the", "in", "for", "on", "to", "at"]);
const KEEP_UPPER = /^(PVT|LTD|LLP|IT|HDFC|ICICI|SBI|UPI|ATM|IMPS|NEFT|RTGS|LIC|GST|EMI|FD|RD|SIP|BSNL|CRED|KFC|IRCTC|OYO|MSEDCL|BESCOM|NPS|PPF|DMart|OK)$/i;

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (KEEP_UPPER.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export interface MerchantMatch {
  name: string;
  key: string;
  known?: KnownMerchant;
  /** 0-1 confidence that `name` is the real underlying business/person (not rails/infrastructure). */
  confidence: number;
  /** True when the only party visible is a payment gateway / PSP - the merchant is unknown. */
  gateway?: boolean;
}

/** Strip reference noise from an unknown counterparty: "SWIGGY*12345", trailing ids, VPA handles. */
export function cleanCounterparty(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/@[A-Z0-9.]+/g, " ")
    .replace(/\*[A-Z0-9]+/g, " ")
    .replace(/\b(?:[A-Z]*\d{4,}[A-Z0-9]*)\b/g, " ")
    .replace(/\b(PAYMENTS?|PVT|LTD|LIMITED)\b\s*$/g, (m) => m) // keep suffix for identity
    .replace(/[^A-Z0-9&'.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchKnownMerchant(...texts: (string | undefined)[]): KnownMerchant | undefined {
  const hay = texts.filter(Boolean).join(" ").toUpperCase();
  if (!hay) return undefined;
  return KNOWN_MERCHANTS.find((m) => m.pattern.test(hay));
}

export interface MerchantHints {
  upiId?: string;
  paymentProvider?: string;
  /** Counterparty token is a payment gateway/PSP (Razorpay, Paytm, ...) rather than a merchant. */
  isGateway?: boolean;
}

/**
 * Canonical merchant for a transaction.
 *  - payment rails (gateway/PSP/bank/UPI handle) are NEVER reported as the merchant;
 *  - known merchants are matched on the counterparty first; UPI narrations may also use the UPI-id
 *    local part, but NOT the free-text note (`PAY VIA RAZORPAY` must not create a merchant);
 *  - non-UPI narrations may fall back to the whole description;
 *  - otherwise the cleaned counterparty is used, at a lower confidence.
 */
export function normalizeMerchant(counterparty: string | undefined, description: string, type?: TxnType, hints: MerchantHints = {}): MerchantMatch {
  if (type === "ATM") return { name: "ATM Cash", key: "ATMCASH", confidence: 0.95 };
  const isUpi = type === "UPI" || type === "REVERSAL";
  const cleanedParty = counterparty ? cleanCounterparty(counterparty) : "";

  if (isUpi && (hints.isGateway ?? isGatewayName(counterparty))) {
    const via = hints.paymentProvider ?? (cleanedParty ? titleCase(cleanedParty) : "payment gateway");
    const name = `Unidentified merchant (${via})`;
    return { name, key: merchantKeyOf(name), confidence: 0.25, gateway: true };
  }

  const byParty = counterparty ? matchKnownMerchant(counterparty) : undefined;
  let known = byParty;
  let via: "party" | "vpa" | "description" = "party";
  if (!known && isUpi && hints.upiId) {
    known = matchKnownMerchant(hints.upiId.split("@")[0].replace(/[0-9._-]+/g, " "));
    via = "vpa";
  } else if (!known && !isUpi) {
    known = matchKnownMerchant(description);
    via = "description";
  }
  if (known) return { name: known.name, key: merchantKeyOf(known.name), known, confidence: via === "party" ? 0.95 : 0.8 };

  if (cleanedParty.length >= 2) {
    const name = titleCase(cleanedParty);
    return { name, key: merchantKeyOf(name), confidence: 0.6 };
  }
  const fallback = titleCase(cleanCounterparty(description).split(" ").slice(0, 3).join(" ")) || "Unknown";
  return { name: fallback, key: merchantKeyOf(fallback) || "UNKNOWN", confidence: 0.3 };
}
