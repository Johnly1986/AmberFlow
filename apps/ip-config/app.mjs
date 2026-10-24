// @amberflow:declarative-data —— 本文件是**数据**（迁移生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app ip-config --write` 生成；改来源再重新生成，不要手改。
// 迁移口径：脚本的 meta()/app() 只是把 pack.json 的字段逐项搬运（含 roles/probe/invariants/journey），
// 不含任何判断；`apps:migrate --all --check` 用 expandPack 逐字段对照来源包。
const META = {
  "id": "ip-config",
  "label": "Excel IP 规划表 → 设备网络设置页（4 行：3 行保存成功 + 1 行被设备页拒绝）",
  "goal": "按 Excel IP 规划表把每台设备的 ip / 子网掩码 / 网关写进它自己的网络设置页；表格里写错的那一行必须由设备页自己的校验拒绝，并被如实报出来",
  "model": "english",
  "max_subgoals": 8,
  "hosts": [],
  "slots": {},
  "sources": [],
  "notes": [
    "本文件由 `npm run apps:gen` 从 `src/ip-config.ts#buildAppPlan` 生成：旅程逐字段等于该来源的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "材料：src/ip-config.ts 的 PAGES / DEMO_ROWS / buildPlan / settingsUrl（页面在 testpages/net_portal.html 与 testpages/net_settings.html）。journey 的前 6 步与 buildPlan(序列号, 行) 的两个子目标对齐 —— desc / start_url / target_hint / slots 逐字段相同；保存步的 signal 是**加固版**（驱动的「已保存」叶子 + 该行自己的 IP，见下一条），由 tests/app-packs-authored.test.ts 断言。",
    "第 4 行 CAM-1003 的 ip=10.0.1.999 是**设计好要被设备页自己的校验拒绝**的（第 4 段超过 255）。本包选择把它**显式写成一步**：该步的完成信号就是设备页的拒绝文案（[data-test=error] 含「IP 地址格式错误」且含规划值本身），所以整条旅程仍然 8/8 done、验收退出码 0 —— 但没有静默丢掉这道设计好的失败：它被声明、被执行、被不变量再次确认（rejection-is-not-reported-as-success）。drivers 那边同一件事报成 REJECTED（读页面自己的错误文案），是 PASS 不是失败；应用包里它就是一个 done 的子目标。",
    "start_url 全部是**相对仓库路径**（testpages/net_portal.html、testpages/net_settings.html?sn=...），运行器按仓库根解析成 file://。",
    "hosts 为空：整条旅程只走仓库自带的 file:// 页面，没有外部主机；sources 为空：没有数据腿。",
    "运行期**不需要 xlsx**：规划表的值（4 行 × 序列号/ip/子网掩码/网关）以计划数据的形式写在 journey 的每个步骤里，所以本应用目录不提交任何二进制。人工输入面仍然是 camera_ips.xlsx —— 缺文件时由 src/ip-config.ts 的 ensureXlsx() 用 DEMO_ROWS 生成；生成器与读取器都在共享层，不是本应用的一部分。",
    "三条「保存」步的 slots 只带自己那一行的 ip/mask/gw（值只来自计划，模型不发明）：执行器在点击前用它们预填页面上的三个空输入框。",
    "保存步的完成信号比驱动**更强**：驱动只断言 [data-test=save-ok] 含「已保存」，本包在此之上再钉一条该行自己的 IP（页面回显形如「已保存 10.0.1.11 / 255.255.255.0 / 10.0.1.1 到 CAM-1001」），所以「保存成功」必须保存的是**这一行**的值，而不只是「某一次保存成功了」。被拒绝那一行的对应加固已经写在它的信号与不变量里（错误文案含 10.0.1.999）。",
    "已知边界：不变量只看 CAM-1003 的结束状态；前三台设备的保存成功由各自的子目标信号保证（[data-test=save-ok] 同时含「已保存」与**这一行**的 IP），那不是结束状态事实。"
  ],
  "invariants": [
    {
      "id": "end-on-the-rejected-device-page",
      "desc": "结束时停在 CAM-1003 自己的网络设置页，页面上是设备页给出的拒绝文案",
      "signal": {
        "all_of": [
          {
            "url_contains": "net_settings.html"
          },
          {
            "css_text_contains": [
              "[data-test=sn]",
              "CAM-1003"
            ]
          },
          {
            "css_text_contains": [
              "[data-test=error]",
              "IP 地址格式错误"
            ]
          }
        ]
      }
    },
    {
      "id": "the-rejected-value-is-the-planned-one",
      "desc": "被拒绝的正是规划表里的那个值（10.0.1.999），不是执行器自己编的",
      "signal": {
        "css_text_contains": [
          "[data-test=error]",
          "10.0.1.999"
        ]
      }
    },
    {
      "id": "rejection-is-not-reported-as-success",
      "desc": "被拒绝的这一行没有谎报成功（save-ok 里没有「已保存」）",
      "signal": {
        "not": {
          "css_text_contains": [
            "[data-test=save-ok]",
            "已保存"
          ]
        }
      }
    }
  ],
  "requiredSlots": []
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "打开 CAM-1001 的网络设置页",
    "start_url": "testpages/net_portal.html",
    "signal": {
      "css_text_contains": [
        "[data-test=sn]",
        "CAM-1001"
      ]
    },
    "target_hint": "a[data-test=net-CAM-1001]"
  },
  {
    "desc": "把规划的 IP / 子网掩码 / 网关 保存到 CAM-1001",
    "start_url": "testpages/net_settings.html?sn=CAM-1001",
    "signal": {
      "all_of": [
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "已保存"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "10.0.1.11"
          ]
        }
      ]
    },
    "target_hint": "button[data-test=net-save]",
    "slots": {
      "ip": "10.0.1.11",
      "mask": "255.255.255.0",
      "gw": "10.0.1.1"
    }
  },
  {
    "desc": "打开 CAM-1002 的网络设置页",
    "start_url": "testpages/net_portal.html",
    "signal": {
      "css_text_contains": [
        "[data-test=sn]",
        "CAM-1002"
      ]
    },
    "target_hint": "a[data-test=net-CAM-1002]"
  },
  {
    "desc": "把规划的 IP / 子网掩码 / 网关 保存到 CAM-1002",
    "start_url": "testpages/net_settings.html?sn=CAM-1002",
    "signal": {
      "all_of": [
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "已保存"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "10.0.1.12"
          ]
        }
      ]
    },
    "target_hint": "button[data-test=net-save]",
    "slots": {
      "ip": "10.0.1.12",
      "mask": "255.255.255.0",
      "gw": "10.0.1.1"
    }
  },
  {
    "desc": "打开 PTZ-2001 的网络设置页",
    "start_url": "testpages/net_portal.html",
    "signal": {
      "css_text_contains": [
        "[data-test=sn]",
        "PTZ-2001"
      ]
    },
    "target_hint": "a[data-test=net-PTZ-2001]"
  },
  {
    "desc": "把规划的 IP / 子网掩码 / 网关 保存到 PTZ-2001",
    "start_url": "testpages/net_settings.html?sn=PTZ-2001",
    "signal": {
      "all_of": [
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "已保存"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=save-ok]",
            "10.0.2.21"
          ]
        }
      ]
    },
    "target_hint": "button[data-test=net-save]",
    "slots": {
      "ip": "10.0.2.21",
      "mask": "255.255.255.0",
      "gw": "10.0.2.1"
    }
  },
  {
    "desc": "打开 CAM-1003 的网络设置页",
    "start_url": "testpages/net_portal.html",
    "signal": {
      "css_text_contains": [
        "[data-test=sn]",
        "CAM-1003"
      ]
    },
    "target_hint": "a[data-test=net-CAM-1003]"
  },
  {
    "desc": "把规划的 IP / 子网掩码 / 网关 提交到 CAM-1003（规划表写的是 10.0.1.999）",
    "start_url": "testpages/net_settings.html?sn=CAM-1003",
    "signal": {
      "all_of": [
        {
          "css_text_contains": [
            "[data-test=error]",
            "IP 地址格式错误"
          ]
        },
        {
          "css_text_contains": [
            "[data-test=error]",
            "10.0.1.999"
          ]
        },
        {
          "not": {
            "css_text_contains": [
              "[data-test=save-ok]",
              "已保存"
            ]
          }
        }
      ]
    },
    "target_hint": "button[data-test=net-save]",
    "slots": {
      "ip": "10.0.1.999",
      "mask": "255.255.255.0",
      "gw": "10.0.1.1"
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });
