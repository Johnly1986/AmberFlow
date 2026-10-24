// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app ota-live --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "ota-live",
  "label": "OTA 线上可达性探针（还有哪家能当「布局相似的旅游网」）",
  "goal": "逐一实测候选 OTA 是否对匿名 + 机房 IP 的访客抛出价格列表；只有真有内容的站点才再用真浏览器渲染一次",
  "hosts": [
    "flight.qunar.com",
    "hotel.qunar.com",
    "www.ly.com",
    "www.tuniu.com",
    "www.booking.com",
    "www.agoda.com",
    "www.expedia.com",
    "www.kayak.com"
  ],
  "notes": [
    "「哪些站点值得再渲染一次」是机械规则（HTTP 层回了 >5000 B 的 HTML，最多前 3 个），不需要数据；「哪些站点、什么 URL、什么算挑战页/下线公告」全在这里声明。",
    "实测结论（已提交语料 transfer/results/ota_probe.json）：本环境下没有任何一家匿名可访问的 OTA 会抛出价格列表。",
    "PORT NOTE：booking/expedia/kayak 原本各自写死了 2026-10-08 的入住日期，现在统一走探针集的日期参数（`{date}`/`{checkout}`）——重跑时它们会跟着运行日期走，而不是永远停在写死的那两天。"
  ],
  "probe": {
    "date": "2026-10-05",
    "results_dir": "transfer/results",
    "http": [
      {
        "id": "qunar-flight",
        "label": "去哪儿机票列表（昆明→北京 2026-10-05）",
        "short": "flight.qunar.com",
        "url": "https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=%E6%98%86%E6%98%8E&searchArrivalAirport=%E5%8C%97%E4%BA%AC&searchDepartureTime={date}"
      },
      {
        "id": "qunar-hotel",
        "label": "去哪儿酒店（北京）",
        "short": "hotel.qunar.com",
        "url": "https://hotel.qunar.com/city/beijing/"
      },
      {
        "id": "ly-hotel",
        "label": "同程酒店（特价酒店）",
        "short": "www.ly.com",
        "url": "https://www.ly.com/hotel/"
      },
      {
        "id": "tuniu",
        "label": "途牛首页",
        "short": "www.tuniu.com",
        "url": "https://www.tuniu.com/"
      },
      {
        "id": "booking-hotel",
        "label": "Booking 北京（入住当日 / 次日离店）",
        "short": "www.booking.com",
        "url": "https://www.booking.com/searchresults.zh-cn.html?ss=%E5%8C%97%E4%BA%AC&checkin={date}&checkout={checkout}&group_adults=1&no_rooms=1"
      },
      {
        "id": "agoda-hotel",
        "label": "Agoda 北京城市页",
        "short": "www.agoda.com",
        "url": "https://www.agoda.com/zh-cn/city/beijing-cn.html"
      },
      {
        "id": "expedia-hotel",
        "label": "Expedia 北京（入住当日 / 次日离店）",
        "short": "www.expedia.com",
        "url": "https://www.expedia.com/Hotel-Search?destination=Beijing&startDate={date}&endDate={checkout}"
      },
      {
        "id": "kayak-hotel",
        "label": "Kayak 北京（入住当日 / 次日离店）",
        "short": "www.kayak.com",
        "url": "https://www.kayak.com/hotels/Beijing,China-c1/{date}/{checkout}"
      }
    ],
    "markers": {
      "challenge_text": [
        "Bot or Not",
        "real user",
        "Challenge Validation",
        "请稍候",
        "安全验证"
      ],
      "notice_text": [
        "停止提供"
      ],
      "price_re": "[¥￥]\\s?\\d[\\d,]*|CN¥\\s?\\d[\\d,]*|US\\$\\s?\\d[\\d,]*",
      "title_re": "<title>(.*?)</title>"
    },
    "baseline": {
      "verdicts": {
        "anonymous_price_list_reachable": "false",
        "qunar_flight_notice": "去哪儿网页版机票查询/预订 2026-10-10 起停止提供（页面公告，实测抓到）",
        "fallback_for_transfer": "用「结构不同、同类任务」的复刻站验证迁移（transfer/），真实站点一侧等能过风控的出口 IP + 登录态，驱动可原样复用"
      }
    }
  }
};
const DATA = {};
const JOURNEY = [];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
