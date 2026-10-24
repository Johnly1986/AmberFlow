// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app camera-entry --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "camera-entry",
  "label": "Excel 类型列路由两套设备录入表单（3 行录入成功 + 1 行被表单拒绝）",
  "goal": "按 Excel 规划表把每台设备录入对应的表单页；识别出的类型用规则选页，空类型按行内证据显式选页；坏序列号由表单自己拒绝并如实报出来",
  "model": "english",
  "maxSubgoals": 4,
  "hosts": [],
  "slots": {},
  "requiredSlots": [],
  "sources": [],
  "notes": [
    "材料：src/camera-entry.ts 的 FORMS.form_a / FORMS.form_b（data-test 选择器）、TYPE_TO_FORM（枪机/筒机→form_a，球机/PTZ→form_b）、DEMO_ROWS（4 行）；页面 testpages/portal.html → camera_a.html / camera_b.html → entry_success.html。",
    "① **识别出的类型用规则选页**：每行的 target_hints 第一个元素就是该表单的入口链接（entry-fixed / entry-ptz），这是 TYPE_TO_FORM 这条字面映射在包里的落地 —— 规则在计划里，不在模型调用里。hint 直接照抄 FORMS 里的 data-test 选择器；两套表单各有各的入口，选错页就没有可填的字段。",
    "② **第 3 行 device_type 为空**：驱动在这种情况下会落到 laya.Router（模型选页）；本包不允许模型在这里赌，所以**显式**选了 PTZ 表单（entry-ptz + b-* 字段），依据是该行自己的证据（序列号 PTZ-2002、带 zoom/presets、没有 resolution/focal）——这与 TYPE_TO_FORM 对 PTZ 的判定同源，只是把「空类型」这一格的决策也写成了计划数据。tests/app-packs-authored.test.ts 另外断言整条旅程没有被问过 act（模型选元素的那个问题），即模型没有参与任何一次选页/选元素。",
    "③ **第 4 行 CAM-12 是设计好被表单拒绝的**（不满足 /^CAM-?\\d{4,}$/，4 位以上数字）。照 A2 的做法把它**显式成步**：该步的完成信号 = 表单自己的错误文案（[data-test=a-error] 含「序列号格式错误」）**加上值本身**。这里有一处与 A2 不同、值得记下：这个表单的错误文案是**固定串**（「序列号格式错误(应为 CAM-XXXX)」），**不回显**输入值，所以「值本身」用 css_value_equals 钉在序列号输入框上 —— 拒绝必须发生在**我们填进去的那个值**上，而不是随便什么值上。这样整条旅程 4/4 done、验收退出码 0，且不变量再确认一次「没有谎报成功」。驱动那边同一件事报成 REJECTED，是 PASS 不是失败。",
    "每一行一个子目标：target_hints 有序地走「点入口 → 填下拉框 → 提交」三次动作。输入框不单独成步，因为每个子目标都会重新导航 —— 分开写会丢掉刚填的值；执行器在**点击前**会用计划槽位预填空输入框（这就是 slots 的用处）。下拉框不在那个预填通道里（FN_EMPTIES 只看 input/textarea），所以它被单独点名为一个 hint，由执行器的 select 填充路径处理。",
    "slots 的键用**页面自己的 data-test**（a-serial / b-sn …），因为两套表单对同一个概念用了不同的名字（serial / a-serial / b-sn）—— 驱动里那张 fields 映射表在包里落成「每个表单自己的键」，值是规划表那一行的原值，模型不发明。",
    "start_url 是相对仓库路径 testpages/portal.html；hosts / sources 都为空：整条旅程只走仓库自带的 file:// 页面，没有外部主机、没有数据腿。",
    "运行期**不需要 xlsx**：规划表的 4 行以计划数据的形式写在 journey 的每一步里，本应用目录不提交任何二进制。人工输入面仍是 devices.xlsx（缺文件时 src/camera-entry.ts 的 ensureXlsx() 回退到 DEMO_ROWS 并在内存里返回），读取器在共享层。",
    "已知边界：不变量只看 CAM-12 的结束状态；前三台设备的录入成功由各自的子目标信号（entry_success.html + ok-serial + ok-form）保证，那不是结束状态事实。"
  ],
  "invariants": [
    {
      "id": "end-on-the-rejected-form",
      "desc": "结束时停在固定焦距表单页，页面上是表单自己的拒绝文案，且输入框里还是我们填的那个值",
      "signal": {
        "all_of": [
          {
            "url_contains": "camera_a.html"
          },
          {
            "css_text_contains": [
              "[data-test='a-error']",
              "序列号格式错误"
            ]
          },
          {
            "css_value_equals": [
              "[data-test='a-serial']",
              "CAM-12"
            ]
          }
        ]
      }
    },
    {
      "id": "rejection-not-reported-as-success",
      "desc": "被拒绝的那一行没有谎报成功（页面回显的 ok-serial 不是 CAM-12）",
      "signal": {
        "not": {
          "css_text_contains": [
            "[data-test=ok-serial]",
            "CAM-12"
          ]
        }
      }
    },
    {
      "id": "end-state-is-the-fixed-form",
      "desc": "结束状态确实是固定焦距表单（序列号输入框在，PTZ 的 S/N 框不在）",
      "signal": {
        "all_of": [
          {
            "css_exists": "[data-test=a-serial]"
          },
          {
            "not": {
              "css_exists": "[data-test=b-sn]"
            }
          }
        ]
      }
    }
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "按规划表录入 CAM-1001（枪机）：进入固定焦距表单，填入该行字段并提交",
    "start_url": "testpages/portal.html",
    "target_hints": [
      "[data-test='entry-fixed']",
      "[data-test='a-resolution']",
      "[data-test='a-submit']"
    ],
    "slots": {
      "a-serial": "CAM-1001",
      "a-model": "DS-2CD1143",
      "a-resolution": "4MP",
      "a-focal": "4",
      "a-ip": "10.0.0.101",
      "a-location": "东门入口"
    },
    "signal": {
      "all_of": [
        {
          "url_contains": "entry_success.html"
        },
        {
          "css_text_contains": [
            "[data-test=ok-serial]",
            "CAM-1001"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=ok-form]",
            "A"
          ]
        }
      ]
    }
  },
  {
    "desc": "按规划表录入 PTZ-2001（球机）：进入 PTZ 表单，填入该行字段并提交",
    "start_url": "testpages/portal.html",
    "target_hints": [
      "[data-test='entry-ptz']",
      "[data-test='b-zoom']",
      "[data-test='b-submit']"
    ],
    "slots": {
      "b-sn": "PTZ-2001",
      "b-model": "SD49425",
      "b-zoom": "20x",
      "b-presets": "8",
      "b-ip": "10.0.0.102",
      "b-location": "中庭广场"
    },
    "signal": {
      "all_of": [
        {
          "url_contains": "entry_success.html"
        },
        {
          "css_text_contains": [
            "[data-test=ok-serial]",
            "PTZ-2001"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=ok-form]",
            "B"
          ]
        }
      ]
    }
  },
  {
    "desc": "按规划表录入 PTZ-2002（类型列空）：行内证据是 PTZ 序列号 + 变倍/预置位，显式进入 PTZ 表单并提交",
    "start_url": "testpages/portal.html",
    "target_hints": [
      "[data-test='entry-ptz']",
      "[data-test='b-zoom']",
      "[data-test='b-submit']"
    ],
    "slots": {
      "b-sn": "PTZ-2002",
      "b-model": "SD6C82",
      "b-zoom": "32x",
      "b-presets": "16",
      "b-ip": "10.0.0.103",
      "b-location": "停车场北"
    },
    "signal": {
      "all_of": [
        {
          "url_contains": "entry_success.html"
        },
        {
          "css_text_contains": [
            "[data-test=ok-serial]",
            "PTZ-2002"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=ok-form]",
            "B"
          ]
        }
      ]
    }
  },
  {
    "desc": "按规划表录入 CAM-12（枪机）：进入固定焦距表单并提交，序列号不合规由表单自己拒绝",
    "start_url": "testpages/portal.html",
    "target_hints": [
      "[data-test='entry-fixed']",
      "[data-test='a-resolution']",
      "[data-test='a-submit']"
    ],
    "slots": {
      "a-serial": "CAM-12",
      "a-model": "DS-2CD1021",
      "a-resolution": "1080P",
      "a-focal": "2.8",
      "a-ip": "10.0.0.104",
      "a-location": "西门"
    },
    "signal": {
      "all_of": [
        {
          "url_contains": "camera_a.html"
        },
        {
          "css_text_contains": [
            "[data-test='a-error']",
            "序列号格式错误"
          ]
        },
        {
          "css_value_equals": [
            "[data-test='a-serial']",
            "CAM-12"
          ]
        }
      ]
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
