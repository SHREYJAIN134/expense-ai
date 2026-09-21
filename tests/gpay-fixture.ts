/**
 * Rows of the real Google Pay statement gpay_statement_20260801_20260831.pdf (01 Aug - 31 Aug 2026), transcribed by running the
 * app's own parser over the PDF. The phone number / e-mail printed in the PDF header is deliberately NOT included.
 * Official totals printed on page 1: Sent 12,379.76 - Received 5,602.
 */
export interface GPayRow {
  date: string;
  time: string; // 24h
  direction: "debit" | "credit";
  counterparty: string;
  id: string;
  amount: number;
  bank: string;
  mask: string;
}

export const GPAY_OFFICIAL = { periodStart: "2026-08-01", periodEnd: "2026-08-31", sent: 12379.76, received: 5602 };

export const GPAY_ROWS: GPayRow[] = [
  { date: "2026-08-01", time: "13:00", direction: "debit", counterparty: "Rahul Negi", id: "621331236828", amount: 625, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-01", time: "13:19", direction: "credit", counterparty: "DivyeshDiptanshu", id: "131924681432", amount: 1220, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-01", time: "16:37", direction: "credit", counterparty: "NEKKALAPU RAMU", id: "536373736492", amount: 3700, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-01", time: "16:56", direction: "debit", counterparty: "Rbgamingzone", id: "127199861329", amount: 80, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-02", time: "09:45", direction: "debit", counterparty: "SEVEN", id: "127233570311", amount: 200, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-02", time: "09:46", direction: "credit", counterparty: "Shivansh Bansal", id: "658074618649", amount: 88, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-02", time: "13:59", direction: "debit", counterparty: "Varsha K", id: "127248280423", amount: 10, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-02", time: "16:51", direction: "debit", counterparty: "rajesh vedha", id: "127256802848", amount: 312, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-02", time: "17:20", direction: "debit", counterparty: "Sreejith M", id: "658096964292", amount: 33, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-04", time: "18:17", direction: "debit", counterparty: "RISWAN K T V", id: "127370493631", amount: 50, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-04", time: "18:18", direction: "debit", counterparty: "RISWAN K T V", id: "127370519836", amount: 20, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "14:42", direction: "debit", counterparty: "MIDLAJ V", id: "127412844215", amount: 10, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "18:25", direction: "debit", counterparty: "Zepto Marketplace Pr", id: "127425097485", amount: 702, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "18:39", direction: "debit", counterparty: "Zepto Marketplace Pr", id: "127426133026", amount: 302, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "20:33", direction: "debit", counterparty: "SWIGGY", id: "658301014778", amount: 259, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "21:14", direction: "debit", counterparty: "Haram Ball", id: "127438320264", amount: 1217, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-05", time: "21:57", direction: "debit", counterparty: "Jahfarali T", id: "127440848111", amount: 181, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-07", time: "00:49", direction: "debit", counterparty: "Airtel Prepaid", id: "621928825751", amount: 100, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-07", time: "18:18", direction: "debit", counterparty: "Airtel Prepaid", id: "127531681525", amount: 39, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-07", time: "18:27", direction: "debit", counterparty: "MR RAMESH MEDABALIMI", id: "127532367214", amount: 6, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-07", time: "21:37", direction: "debit", counterparty: "UDAY TEA STALL", id: "127546722330", amount: 5, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-08", time: "17:57", direction: "debit", counterparty: "Sasishkar Official", id: "127585652155", amount: 45, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-08", time: "18:23", direction: "debit", counterparty: "JABIR", id: "127587662300", amount: 60, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-08", time: "20:37", direction: "debit", counterparty: "Masthan M", id: "622096923226", amount: 33, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "00:15", direction: "debit", counterparty: "Blinkit", id: "127607874441", amount: 423, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "14:50", direction: "debit", counterparty: "Bundl Technologies pvt Ltd", id: "127632322386", amount: 238, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "18:29", direction: "debit", counterparty: "BIG SAVE SUPERMARKET", id: "127644792623", amount: 143, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "19:37", direction: "debit", counterparty: "ARUNACHALAM M", id: "658706614194", amount: 33, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "19:47", direction: "debit", counterparty: "ADITYA VIJAY", id: "658792418099", amount: 170, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-09", time: "22:22", direction: "debit", counterparty: "RISWAN K T V", id: "127661234602", amount: 35, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-10", time: "18:29", direction: "debit", counterparty: "ZEPTO MARKETPLACE PRIVATE LIMITED", id: "127699981067", amount: 539, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-10", time: "22:13", direction: "debit", counterparty: "SWIGGY", id: "622262642152", amount: 385, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "00:45", direction: "debit", counterparty: "Airtel Prepaid", id: "622310553456", amount: 49, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "16:50", direction: "debit", counterparty: "Indian Railways", id: "127747445892", amount: 10, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "18:11", direction: "debit", counterparty: "SHASHWAT", id: "127752468556", amount: 280, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "18:48", direction: "debit", counterparty: "Saravana Saravana", id: "658900921226", amount: 37, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "19:19", direction: "debit", counterparty: "Utkarsh Yadav", id: "658934810199", amount: 200, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-11", time: "22:33", direction: "debit", counterparty: "Google Play", id: "895153862236", amount: 599, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-12", time: "01:02", direction: "debit", counterparty: "be10x", id: "127772650693", amount: 231.4, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-12", time: "10:00", direction: "debit", counterparty: "Blinkit", id: "127780470996", amount: 277, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-12", time: "14:31", direction: "debit", counterparty: "ADITYA", id: "659064297921", amount: 70, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-12", time: "22:06", direction: "debit", counterparty: "SWIGGY", id: "622474862679", amount: 436, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-13", time: "09:42", direction: "credit", counterparty: "DEVANSH KHANNA", id: "312349892264", amount: 280, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-13", time: "21:20", direction: "debit", counterparty: "JUICE CAFE 2", id: "127870966800", amount: 30, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-14", time: "12:19", direction: "debit", counterparty: "SPOTIFY INDIA PVT LTD", id: "103864579706", amount: 139, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-14", time: "12:43", direction: "debit", counterparty: "Saravanan Saravanankumar", id: "659286093958", amount: 80, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-14", time: "13:52", direction: "debit", counterparty: "ADITYA", id: "622606111725", amount: 175, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-15", time: "01:01", direction: "debit", counterparty: "DEVANSH KHANNA", id: "622722687335", amount: 100, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-15", time: "02:20", direction: "debit", counterparty: "DEVANSH KHANNA", id: "622755684527", amount: 100, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-15", time: "02:25", direction: "debit", counterparty: "Blinkit", id: "622758185216", amount: 266, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-15", time: "16:29", direction: "debit", counterparty: "BISWA PRAKASH ROUT", id: "659306444685", amount: 62, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-16", time: "20:15", direction: "debit", counterparty: "Bigsave Supermarket", id: "128028683163", amount: 68, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-19", time: "22:45", direction: "debit", counterparty: "Zepto", id: "128191479733", amount: 175, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-19", time: "22:45", direction: "debit", counterparty: "Zepto", id: "128191496035", amount: 84, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-20", time: "13:23", direction: "debit", counterparty: "p jeeva", id: "128211315368", amount: 43, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-20", time: "21:52", direction: "debit", counterparty: "JUICE CAFE 2", id: "128243549200", amount: 30, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-21", time: "16:09", direction: "debit", counterparty: "Bipin Kumar", id: "128273628604", amount: 150, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-21", time: "16:16", direction: "debit", counterparty: "Bipin Kumar", id: "128273943633", amount: 240, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-21", time: "16:52", direction: "debit", counterparty: "DURGA SWAMI SUPER MARKET", id: "128275767405", amount: 20, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-23", time: "14:03", direction: "debit", counterparty: "Rapido", id: "128373765195", amount: 33, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-23", time: "20:41", direction: "debit", counterparty: "BLINKIT COMMERCE PRIVATE LIMITED", id: "128397789140", amount: 475, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-23", time: "21:14", direction: "debit", counterparty: "Irshad K V", id: "128399897165", amount: 40, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "01:32", direction: "debit", counterparty: "Naseeb P P", id: "128405676998", amount: 100, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "01:32", direction: "credit", counterparty: "DEVANSH KHANNA", id: "213946740070", amount: 50, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "14:23", direction: "debit", counterparty: "ZEPTO MARKETPLACE PRIVATE LIMITED", id: "128426660185", amount: 325, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "16:06", direction: "credit", counterparty: "Kunal Gulia", id: "128431517914", amount: 150, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "16:09", direction: "credit", counterparty: "Mr Yashpal Meel", id: "612787132812", amount: 114, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-24", time: "17:29", direction: "debit", counterparty: "THE DEN Indoor Sports Academy", id: "128435953594", amount: 250, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-25", time: "12:58", direction: "debit", counterparty: "FK FOODKING", id: "128474017428", amount: 30, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-25", time: "19:26", direction: "debit", counterparty: "JUICE CAFE 2", id: "128496524270", amount: 40, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-25", time: "22:00", direction: "debit", counterparty: "AMMAVASAI ARCHANA", id: "128506886358", amount: 20, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-25", time: "23:41", direction: "debit", counterparty: "Karnak Datta", id: "660324187499", amount: 20, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "03:40", direction: "debit", counterparty: "MILKYWAY AND MANSUKH C1", id: "128510980754", amount: 20, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "06:04", direction: "debit", counterparty: "Suresh Dav", id: "660435293603", amount: 42, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "15:27", direction: "debit", counterparty: "Kiddo", id: "623806707331", amount: 169, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "16:17", direction: "debit", counterparty: "Blinkit", id: "128535181990", amount: 231, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "16:49", direction: "debit", counterparty: "Karnak Datta", id: "128536644403", amount: 60, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-26", time: "18:19", direction: "debit", counterparty: "Tamil Selvan", id: "128541859059", amount: 33, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-27", time: "16:09", direction: "debit", counterparty: "Utkarsh Yadav", id: "128587250167", amount: 10, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-28", time: "16:57", direction: "debit", counterparty: "VENDOLITE INDIA", id: "128645610958", amount: 90, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-29", time: "10:20", direction: "debit", counterparty: "FK FOODKING", id: "128676138761", amount: 81, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-30", time: "22:30", direction: "debit", counterparty: "FLIVE CONSULTING PRIVATE LIMITED", id: "128767130554", amount: 102.36, bank: "HDFC Bank", mask: "9332" },
  { date: "2026-08-31", time: "15:38", direction: "debit", counterparty: "STAR XEROXS", id: "128794719014", amount: 2, bank: "HDFC Bank", mask: "9332" },
];
