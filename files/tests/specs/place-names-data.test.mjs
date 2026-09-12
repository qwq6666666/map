import { test, run, assertEqual, assertTrue } from '../assert.mjs';
import buildPlaceNames from '../../tools/build-place-names.js';

/* ---------------------------------------------------------
   tests/specs/place-names-data.test.mjs
   ---------------------------------------------------------
   針對 tools/build-place-names.js 的四個純函式（parseCsv／
   splitAliases／extractAliasesFromDescription／rowToPlace）寫測試，
   全部用寫死在測試檔裡的小段輸入，不依賴任何工作區外的真實 CSV 檔案。
   tools/ 底下是獨立的 CommonJS 模組（見 tools/package.json），這裡用
   預設匯入拿到整個 module.exports 物件再解構。
--------------------------------------------------------- */
const { parseCsv, splitAliases, extractAliasesFromDescription, rowToPlace } = buildPlaceNames;

test('module.exports 應該正確匯出四個函式', () => {
  assertEqual(typeof parseCsv, 'function', 'parseCsv 應該是函式');
  assertEqual(typeof splitAliases, 'function', 'splitAliases 應該是函式');
  assertEqual(typeof extractAliasesFromDescription, 'function', 'extractAliasesFromDescription 應該是函式');
  assertEqual(typeof rowToPlace, 'function', 'rowToPlace 應該是函式');
});

/* ---------------- parseCsv ---------------- */

test('parseCsv：一般逗號分隔列', () => {
  const rows = parseCsv('a,b,c\n1,2,3');
  assertEqual(rows.length, 2, '應該有 2 列');
  assertEqual(rows[0].join('|'), 'a|b|c', '第一列欄位應正確拆分');
  assertEqual(rows[1].join('|'), '1|2|3', '第二列欄位應正確拆分');
});

test('parseCsv：欄位帶雙引號且內含逗號', () => {
  const rows = parseCsv('a,"b,c",d');
  assertEqual(rows.length, 1, '應該只有 1 列');
  assertEqual(rows[0].length, 3, '應該只有 3 個欄位（引號內的逗號不應該被當成分隔符）');
  assertEqual(rows[0][1], 'b,c', '第二欄應該是含逗號的完整字串');
});

test('parseCsv：欄位帶 "" 轉義雙引號', () => {
  const rows = parseCsv('"he said ""hi"""');
  assertEqual(rows.length, 1, '應該只有 1 列');
  assertEqual(rows[0][0], 'he said "hi"', '"" 應該被轉義成一個字面雙引號');
});

test('parseCsv：CRLF / LF 混合換行皆視為換列', () => {
  const rows = parseCsv('a,b\r\nc,d\ne,f');
  assertEqual(rows.length, 3, '應該有 3 列（CRLF 與 LF 都要正確斷列）');
  assertEqual(rows[1].join('|'), 'c|d', '第二列（CRLF 後）應該正確拆分');
  assertEqual(rows[2].join('|'), 'e|f', '第三列（LF 後）應該正確拆分');
});

test('parseCsv：空白列會被過濾掉', () => {
  const rows = parseCsv('a,b\n\nc,d\n');
  assertEqual(rows.length, 2, '中間的空白列不應該出現在結果中');
  assertEqual(rows[0].join('|'), 'a|b');
  assertEqual(rows[1].join('|'), 'c|d');
});

/* ---------------- splitAliases ---------------- */

test('splitAliases：頓號分隔的混合別名', () => {
  const result = splitAliases('卜吉、化番社', '德化社');
  assertEqual(result.join(','), '卜吉,化番社', '應該依頓號拆分成兩個別名');
});

test('splitAliases：頓號/逗號/分號/間隔號混合分隔', () => {
  const result = splitAliases('甲,乙；丙・丁、戊', '主名');
  assertEqual(result.join(','), '甲,乙,丙,丁,戊', '應該用各種分隔符正確拆分');
});

test('splitAliases：跟 name 相同的片段要被排除', () => {
  const result = splitAliases('德化社、卜吉', '德化社');
  assertEqual(result.join(','), '卜吉', '跟主名相同的片段應被排除');
});

test('splitAliases：重複片段要去重', () => {
  const result = splitAliases('卜吉、卜吉、化番社', '德化社');
  assertEqual(result.join(','), '卜吉,化番社', '重複片段應該只留一份');
});

test('splitAliases：純空字串輸入回傳空陣列', () => {
  assertEqual(splitAliases('', '德化社').length, 0, '空字串輸入應該回傳空陣列');
});

test('splitAliases：undefined/null 輸入回傳空陣列', () => {
  assertEqual(splitAliases(undefined, '德化社').length, 0, 'undefined 輸入應該回傳空陣列');
  assertEqual(splitAliases(null, '德化社').length, 0, 'null 輸入應該回傳空陣列');
});

/* ---------------- extractAliasesFromDescription ---------------- */

test('extractAliasesFromDescription：「舊稱」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('本地舊稱阿罩霧，清代設庄', '霧峰');
  assertEqual(result.join(','), '阿罩霧', '應該抓出「舊稱」後面的候選');
});

test('extractAliasesFromDescription：「原名」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('本聚落原名錫口，因位於基隆河渡口而得名', '松山');
  assertEqual(result.join(','), '錫口', '應該抓出「原名」後面的候選');
});

test('extractAliasesFromDescription：「又名」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('此地又名打狗，為重要港口', '高雄');
  assertEqual(result.join(','), '打狗', '應該抓出「又名」後面的候選');
});

test('extractAliasesFromDescription：「俗稱」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('當地俗稱三重埔，因地勢低窪而得名', '三重');
  assertEqual(result.join(','), '三重埔', '應該抓出「俗稱」後面的候選');
});

test('extractAliasesFromDescription：「古稱」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('本地古稱大加蚋，為平埔族社名', '大加蚋堡');
  assertEqual(result.join(','), '大加蚋', '應該抓出「古稱」後面的候選');
});

test('extractAliasesFromDescription：「曾稱」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('日治時期曾稱錦町，光復後改名', '錦华里');
  assertEqual(result.join(','), '錦町', '應該抓出「曾稱」後面的候選');
});

test('extractAliasesFromDescription：「改稱」前導語句抓出候選', () => {
  const result = extractAliasesFromDescription('民國九年改稱員林，沿用至今', '員林鎮');
  assertEqual(result.join(','), '員林', '應該抓出「改稱」後面的候選');
});

test('extractAliasesFromDescription：同一句內兩個前導語句，其中一個候選跟主名稱相同時會被排除', () => {
  const result = extractAliasesFromDescription('舊稱阿罩霧，日治時期改稱霧峰', '霧峰');
  assertEqual(result.join(','), '阿罩霧', '「改稱」後面的「霧峰」跟主名稱相同應該被排除，只留「舊稱」抓到的「阿罩霧」');
});

test('extractAliasesFromDescription：無前導語句的一般敘述文字抓不到任何東西', () => {
  assertEqual(extractAliasesFromDescription('無沿革記載', '某地').length, 0, '「無沿革記載」不應該抓出任何候選');
  assertEqual(extractAliasesFromDescription('地勢平坦', '某地').length, 0, '「地勢平坦」不應該抓出任何候選');
});

test('extractAliasesFromDescription：前導語句後緊接標點（引號）抓不到——刻意行為，避免以後改動 regex 時意外誤抓整句', () => {
  const result = extractAliasesFromDescription('又名『打狗』，為重要港口', '高雄');
  assertEqual(result.length, 0, '「又名」後面緊接『』全形引號時，目前設計是抓不到候選（不會誤抓成空字串或整句）');
});

test('extractAliasesFromDescription：前導語句後緊接冒號抓不到——同樣是刻意行為', () => {
  const result = extractAliasesFromDescription('俗稱：三重埔', '三重');
  assertEqual(result.length, 0, '「俗稱」後面緊接冒號時，目前設計是抓不到候選');
});

test('extractAliasesFromDescription：description 為空字串／undefined／null 都回傳空陣列', () => {
  assertEqual(extractAliasesFromDescription('', '某地').length, 0, '空字串應該回傳空陣列');
  assertEqual(extractAliasesFromDescription(undefined, '某地').length, 0, 'undefined 應該回傳空陣列');
  assertEqual(extractAliasesFromDescription(null, '某地').length, 0, 'null 應該回傳空陣列');
});

test('extractAliasesFromDescription：候選片段超過 8 字時在第 8 字處截斷', () => {
  const result = extractAliasesFromDescription('本地舊稱一二三四五六七八九十，其餘從略', '某地');
  assertEqual(result.join(','), '一二三四五六七八', '候選片段應該只取前 8 個字，超過的部分不納入');
});

test('extractAliasesFromDescription：前導語句剛好在字串最尾端、沒有後續內容時不拋錯，回傳空陣列', () => {
  const result = extractAliasesFromDescription('本地舊稱', '某地');
  assertEqual(result.length, 0, '前導語句後面沒有任何字元可組成候選時，應該回傳空陣列而不是拋錯');
});

test('extractAliasesFromDescription：已知誤判案例（現況記錄，非預期修正）——「由來與開墾有關」後接「原名同今名」會被誤抓成候選', () => {
  // 這是已知限制：regex 只看「原名」後面緊接的短字串，無法理解語意，
  // 「原名同今名」這種「表示沒有另外的舊名」的敘述會被誤判成候選「同今名」。
  // 目前沒有真實 CSV 可驗證大規模套用後的誤判率有多嚴重，這裡先如實記錄
  // 現況行為，日後若要調整 DESC_ALIAS_LEAD_PATTERNS 或補停用詞規則，
  // 這個測試案例可以拿來對照修正前後的差異。
  const result = extractAliasesFromDescription('地名由來與開墾有關，原名同今名', '某地');
  assertEqual(result.join(','), '同今名', '已知誤判：目前會把「同今名」誤判成候選別名');
});

/* ----------------------------------------------------------------
   以下用真實內政部「臺灣地區地名資料」CSV（聚落類／行政區域類）原文
   當 fixture，鎖住兩輪真實資料回歸修正後的行為：
     1. 連接詞跳過（前導語句後緊接「為」「稱」要先跳過再擷取候選）
     2. 殘留詞過濾（「沿用至今」整句殘留／「此」「應為」「該」開頭指示詞捨棄）
     3. 機構名尾綴過濾（候選以「公所」「支署」「支廳」等結尾捨棄）
   全部用 node 直接讀真實 CSV 撈出、逐字核對過，非手寫杜撰。
---------------------------------------------------------------- */

test('extractAliasesFromDescription：真實案例（富興村，花蓮縣瑞穗鄉）——「改稱為富興」要跳過「為」，抓到「富興」而非「為富興」', () => {
  const desc =
    '富興村位在富源、富民兩村東側原野間，清代舊稱溪底仔，緣於此地原為拔仔庄外的溪埔地，' +
    '故居民多以「溪底仔」稱之。日治時仍屬拔仔庄（白川）所轄，民國35年（1946）設村，改稱為富興。';
  const result = extractAliasesFromDescription(desc, '富興村');
  assertEqual(result.join(','), '溪底仔,富興', '應抓到「舊稱」的「溪底仔」與「改稱為」跳過連接詞後的「富興」（不是「為富興」）');
});

test('extractAliasesFromDescription：真實案例（安宜里，高雄市三民區）——「原名稱安宜里」跳過連接詞「稱」後，候選與主名稱相同應被排除，不殘留「稱安宜里」', () => {
  const desc =
    '安宜里位於三民區中心附近偏東，里界範圍南起察哈爾二街與安邦里為界，北迄愛河支流與鼓山區為鄰，' +
    '東至哈爾濱街與安泰里為界，西至中華二路，全里面積約0.4平方公里。民國一一?年（2021）十二月底，' +
    '共25鄰，3,389人。清光緒十三年（1887），本里隸屬於臺南府鳳山縣大竹里三塊厝庄。日治時代明治卅四年' +
    '（1901）里隸屬於鳳山廳大竹里三塊厝庄；大正九年（1920）隸屬於高雄州高雄郡高雄街三塊厝大字；' +
    '大正十三年（1924）改制為高雄市，仍屬三塊厝大字。戰後整編為德東里轄區，於民國五十八年（1969）' +
    '五月行政區重新劃分成立安宜里。民國六十三年（1974）人口增加到已超過1000多戶，因而重新調整行政區域，' +
    '以察哈爾二街為界，以南成立安邦里，以北則保留原名稱安宜里。民國七?年（1981）將哈爾濱街以東分出安泰里，' +
    '以西仍為本里，以至今日。本里里名源於安生村沿用的安生里，以「安」為首字，再加吉言佳字，故名之。' +
    '本里在日治時代（1895-1945）屬於三塊厝庄，為一片農地，本里屬於高雄市第八期重劃，為棋盤式街道。' +
    '里域北有愛河河道，里內有一支流從東南流向西北，河岸地勢較高，日治初期作為墓地，日治中期可能已經遷移。' +
    '戰後里內房舍漸見，直到民國七十年代（1980s），自立路東側的街廓多為建成區，自立路西邊也有工廠分布，' +
    '附近被規劃為三民區2號公園，現名為三民敦新公園，公園內後來設高雄市客家文物館。';
  const result = extractAliasesFromDescription(desc, '安宜里');
  assertEqual(result.length, 0, '「原名稱安宜里」跳過「稱」後候選是「安宜里」，跟主名稱相同應被排除，結果應為空陣列（不含「稱安宜里」）');
});

test('extractAliasesFromDescription：真實案例（南汕里，高雄市旗津區）——連接詞跳過＋機構名尾綴雙重過濾，「改稱為第二區公所」「改稱旗津區公所」都不應殘留', () => {
  const desc =
    '南汕里位於本區中間地帶，北接北汕里，南鄰上竹里，西臨臺灣海峽，東瀕高雄港。里面積有0.2032平方公里，' +
    '民國一一?年（2021）十二月，共13鄰，2,200人。清代屬大竹里的頂烏松、下烏松、大汕頭，日治時代' +
    '（1895-1945）屬烏松庄，後來為綠町的一部分，屬於中洲區會管轄；戰後初期，將中洲區會改稱為第二區公所，' +
    '後來與第一區公所合併，改稱旗津區公所。民國卅五年（1946）設置南汕里，民國四十二年（1953）六月一日' +
    '將「北汕里」併入本里；民國六十四年（1975）七月一日又因人口日增，再從南汕里析分出「北汕里」，以迄於今。' +
    '里名源於大汕頭，本里屬大汕頭聚落的南邊，故稱南汕里。本里早期分為頂頭（即今第一鄰）和下頭（頂寮、下寮），' +
    '孫氏多居頂寮，蔡氏多居於下寮；吳姓來自鳳鼻頭中坑門，王姓來自港口。本里原為漁村形態，大汕頭居民均靠捕魚為生，' +
    '日治時代（1895-1945）本轄內有東洋株式會社（即今大汕國民小學）、高雄水產加工會社（即今李文豹現址）、' +
    '協隆興公司（即今新昇發造船公司）及日本人永井文治（中洲區區長）經營食堂。戰後東北側內海建闢為儲木池，' +
    '民國七十九年（1990）第一貯木池第六、七區開始改建為「旗津漁港」，民國八十八年（1999）七月四日啟用。' +
    '里內有旗津國民中學、大汕國民小學、海星托兒所、中區汙水處理廠。由於本里瀕臨高雄港一帶，為港埠用地，' +
    '有多家造船公司。';
  const result = extractAliasesFromDescription(desc, '南汕里');
  assertEqual(result.length, 0, '「第二區公所」「旗津區公所」都以機構名尾綴結尾應被捨棄，結果應為空陣列');
});

test('extractAliasesFromDescription：真實案例（石牌村，花蓮縣富里鄉）——「為清代舊稱沿用至今」整句殘留應捨棄', () => {
  const result = extractAliasesFromDescription('因其地有兩石對立，高約六尺，形狀似牌而得名。為清代舊稱沿用至今。', '石牌村');
  assertEqual(result.length, 0, '「舊稱」後緊接的候選是「沿用至今」，屬於語意殘留應捨棄，結果應為空陣列');
});

test('extractAliasesFromDescription：真實案例（賊仔市，嘉義市東區）——「故俗稱此地為賊仔市」的「此地為」指示詞開頭候選應捨棄', () => {
  const result = extractAliasesFromDescription('民國38年後有許多外省籍人士佔據此地賣贓物，故俗稱此地為「賊仔市」', '賊仔市');
  assertEqual(result.length, 0, '「俗稱」後緊接的候選是「此地為」，以「此」開頭屬於指示詞殘留應捨棄，結果應為空陣列');
});

test('extractAliasesFromDescription：真實案例（鯉魚窟，南投縣埔里鎮）——「原名應為鱺魚潭」的「應為」揣測詞開頭候選應捨棄', () => {
  const result = extractAliasesFromDescription('居民認為原名應為「鱺魚潭」，因潭內多高貴魚類「鱺魚」而名（另有一說指鯉魚）。', '鯉魚窟');
  assertEqual(result.length, 0, '「原名」後緊接的候選是「應為」，以「應為」開頭屬於揣測詞殘留應捨棄，結果應為空陣列');
});

test('extractAliasesFromDescription：真實案例（日本宿舍，嘉義縣朴子市）——「改稱樸仔腳支署」「改稱樸仔腳支廳」機構名尾綴應捨棄，但同句「舊衙門」不受影響、正常保留', () => {
  // 全站真正觸發「支署／支廳」機構名尾綴過濾的案例：PlaceName 是「日本宿舍」
  // （非樸仔腳本身——樸仔腳只是沿革文字裡提到的舊機構名稱片段）。
  const desc =
    '為日據時代明治三十年成立樸仔腳辦務署。明治三十三年改稱樸仔腳支署，明治三十四年置廳時期又改稱樸仔腳支廳，' +
    '俗稱舊衙門，其東北向周圍為長官及屬吏是日本宿舍之由來，光復後政府收編為縣政府朴子宿舍。' +
    '北側現軍公教福利中心有所謂蕃仔墓葬庄崎支廳長及宮下郵便局長之舊址，現已不復見。';
  const result = extractAliasesFromDescription(desc, '日本宿舍');
  assertEqual(result.join(','), '舊衙門', '「樸仔腳支署」「樸仔腳支廳」都以機構名尾綴結尾應被捨棄，只留下不受影響的「舊衙門」');
});

test('extractAliasesFromDescription：真實案例（大禹里，花蓮縣玉里鎮）——沿革文字品質良好時應正常抽出真正舊名「末廣」', () => {
  const desc =
    '大里舊名針塱，相傳，此地曾有毒樹，阿美族語稱它為「斯頓Sedeng」，漢人譯作針塱，民國六年' +
    '（大正6年，1917）日人改稱末廣，光復後易名大禹（駱香林，1983：64），舊文獻或譯作周塱、新塱、金塱' +
    '（夏獻綸，1996：78；台灣省文獻委員會，1994：33-35），現居當地的漢人大多仍沿舊習稱為Sinlon（信農）。';
  const result = extractAliasesFromDescription(desc, '大禹里');
  assertEqual(result.join(','), '末廣', '「改稱末廣」應正常抽出候選「末廣」（沿革文字開頭的「舊名針塱」用的是「舊名」而非「舊稱」，不在前導語句清單內，本就不會被抓到）');
});

/* ---------------- rowToPlace ---------------- */

const HEADER = ['Type','PlaceName','ChinesePhonetic','CommonPhonetic','AnotherName',
  'County','CountyCode','Town','TownCode','Village','PlaceMean','Longitude','Latitude'];

test('rowToPlace：正常一列（含經緯度、含別名）轉出正確物件', () => {
  const row = ['聚落','德化社','','','卜吉、化番社','南投縣','','魚池鄉','','','日月潭邊的聚落','120.9123','23.8567'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!!place, '應該回傳有效物件');
  assertEqual(place.name, '德化社');
  assertEqual(place.aliases.join(','), '卜吉,化番社');
  assertEqual(place.county, '南投縣');
  assertEqual(place.town, '魚池鄉');
  assertEqual(place.description, '日月潭邊的聚落');
  assertEqual(place.sourceType, 'settlement');
  assertEqual(place.longitude, 120.9123);
  assertEqual(place.latitude, 23.8567);
});

test('rowToPlace：PlaceName 空白時回傳 null', () => {
  const row = ['聚落','','','','','南投縣','','魚池鄉','','','','120.9','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place, null, 'PlaceName 空白應該回傳 null');
});

test('rowToPlace：PlaceName 只有空白字元時也視為空、回傳 null', () => {
  const row = ['聚落','   ','','','','南投縣','','魚池鄉','','','','120.9','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place, null, '只有空白字元的 PlaceName 應該視為空');
});

test('rowToPlace：經度缺值時，輸出物件不應該有 longitude/latitude 這兩個 key', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!('longitude' in place), '經度缺值時不應該有 longitude key');
  assertTrue(!('latitude' in place), '經度缺值時也不應該有 latitude key（要嘛兩個都有，要嘛都沒有）');
});

test('rowToPlace：緯度缺值時，輸出物件不應該有 longitude/latitude 這兩個 key', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','120.7',''];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertTrue(!('longitude' in place), '緯度缺值時不應該有 longitude key');
  assertTrue(!('latitude' in place), '緯度缺值時也不應該有 latitude key');
});

test('rowToPlace：AnotherName 為空時 aliases 應為空陣列', () => {
  const row = ['聚落','社寮','','','','南投縣','','竹山鎮','','','','120.7','23.8'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(place.aliases.length, 0, '沒有別名應該是空陣列');
});

test('rowToPlace：sourceType 正確帶入 admin', () => {
  const row = ['行政區域','南投市','','','','南投縣','','南投市','','','','120.68','23.91'];
  const place = rowToPlace(HEADER, row, 'admin');
  assertEqual(place.sourceType, 'admin', 'sourceType 應該正確帶入 admin');
});

test('rowToPlace：aliases 併入 splitAliases(AnotherName) 與 extractAliasesFromDescription(PlaceMean) 兩者結果，且互相重複時不重複', () => {
  // AnotherName 跟 PlaceMean 沿革文字都各自抓到「阿罩霧」，另外 AnotherName
  // 還有一個獨有的「涼傘樹」——驗證最終 aliases 是兩邊來源的聯集且去重複。
  const row = ['聚落','霧峰','','','阿罩霧、涼傘樹','臺中市','','霧峰區','','','舊稱阿罩霧，因地勢而得名','120.71','24.07'];
  const place = rowToPlace(HEADER, row, 'settlement');
  assertEqual(
    Array.from(new Set(place.aliases)).length,
    place.aliases.length,
    'aliases 陣列本身不應該有重複項目'
  );
  assertEqual(
    [...place.aliases].sort().join(','),
    ['阿罩霧', '涼傘樹'].sort().join(','),
    'aliases 應該是 AnotherName 與 PlaceMean 沿革抽取結果的聯集（「阿罩霧」在兩邊都出現，最終只留一份）'
  );
});

/* ----------------------------------------------------------------
   以下用真實 CSV 原文做 rowToPlace 整合測試，驗證
   splitAliases(AnotherName) 與 extractAliasesFromDescription(PlaceMean)
   合併去重複的完整流程，同時鎖住真實案例的過濾行為。
---------------------------------------------------------------- */

test('rowToPlace：真實案例（南汕里，高雄市旗津區）——同時觸發連接詞跳過與機構名尾綴過濾，最終 aliases 應為空陣列，不含任何被過濾候選', () => {
  const description =
    '南汕里位於本區中間地帶，北接北汕里，南鄰上竹里，西臨臺灣海峽，東瀕高雄港。里面積有0.2032平方公里，' +
    '民國一一?年（2021）十二月，共13鄰，2,200人。清代屬大竹里的頂烏松、下烏松、大汕頭，日治時代' +
    '（1895-1945）屬烏松庄，後來為綠町的一部分，屬於中洲區會管轄；戰後初期，將中洲區會改稱為第二區公所，' +
    '後來與第一區公所合併，改稱旗津區公所。民國卅五年（1946）設置南汕里，民國四十二年（1953）六月一日' +
    '將「北汕里」併入本里；民國六十四年（1975）七月一日又因人口日增，再從南汕里析分出「北汕里」，以迄於今。' +
    '里名源於大汕頭，本里屬大汕頭聚落的南邊，故稱南汕里。本里早期分為頂頭（即今第一鄰）和下頭（頂寮、下寮），' +
    '孫氏多居頂寮，蔡氏多居於下寮；吳姓來自鳳鼻頭中坑門，王姓來自港口。本里原為漁村形態，大汕頭居民均靠捕魚為生，' +
    '日治時代（1895-1945）本轄內有東洋株式會社（即今大汕國民小學）、高雄水產加工會社（即今李文豹現址）、' +
    '協隆興公司（即今新昇發造船公司）及日本人永井文治（中洲區區長）經營食堂。戰後東北側內海建闢為儲木池，' +
    '民國七十九年（1990）第一貯木池第六、七區開始改建為「旗津漁港」，民國八十八年（1999）七月四日啟用。' +
    '里內有旗津國民中學、大汕國民小學、海星托兒所、中區汙水處理廠。由於本里瀕臨高雄港一帶，為港埠用地，' +
    '有多家造船公司。';
  const row = ['行政區域', '南汕里', '', '', '', '高雄市', '', '旗津區', '', '', description, '', ''];
  const place = rowToPlace(HEADER, row, 'admin');
  assertTrue(!!place, '應該回傳有效物件');
  assertEqual(place.aliases.length, 0, 'AnotherName 為空、PlaceMean 抽取的候選又全被連接詞跳過＋機構名尾綴過濾掉，最終 aliases 應為空陣列');
});

test('rowToPlace：真實案例（松浦里，花蓮縣玉里鎮）——AnotherName 與 PlaceMean 沿革都提到「猛仔蘭」，兩來源合併去重複，並保留沿革另抽出的「松浦」', () => {
  const description =
    '松浦里舊稱猛仔蘭（Mangcelan），是阿美族語，為蜣螂之意或山羌，，因其地多蜣螂故名，建社時以此為社名。' +
    '民國二十六年（昭和12年，1937），日人改稱松浦。';
  const row = ['行政區域', '松浦里', '', '', '猛仔蘭', '花蓮縣', '', '玉里鎮', '', '', description, '', ''];
  const place = rowToPlace(HEADER, row, 'admin');
  assertTrue(!!place, '應該回傳有效物件');
  assertEqual(
    Array.from(new Set(place.aliases)).length,
    place.aliases.length,
    'aliases 陣列本身不應該有重複項目'
  );
  assertEqual(
    [...place.aliases].sort().join(','),
    ['猛仔蘭', '松浦'].sort().join(','),
    'aliases 應該是 AnotherName 的「猛仔蘭」與 PlaceMean 沿革抽取結果「猛仔蘭、松浦」的聯集（「猛仔蘭」兩邊都出現，最終只留一份）'
  );
});

await run();
