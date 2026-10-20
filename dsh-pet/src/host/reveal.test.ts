/**
 * 「点击系统通知 → 跳到那条会话 + 唤起 DSH 桌面窗口」契约测试。
 *
 * 现象：宿主是 DSH 桌面应用时，任务完成的通知点了没反应。通知是**网页**（Electron 渲染进程）发的，
 * 那边的 `window.focus()` 只能聚焦页面、恢复不了最小化的宿主窗口；唤起只能由宿主动手。
 * 点击还得**跳到发出这条通知的会话**——否则用户回到窗口看到的还是旧对话。
 *
 * 链路（任一侧丢分支/改名即失败）：
 *   host index.ts 监听 session/event → withSessionId 把会话 id 写进通知帧 → /state 的 sections.notify
 *   → client notify.ts 点击处理：页内 uiWorkspace.openSession(sessionId)（app.ts 注入）
 *     + window.focus() + POST /dsh-pet-7340/reveal
 *   → host index.ts 的 reveal 路由 → revealDesktopWindow()（仅桌面宿主）
 *   → 平台 shell 命令打开 `dsh://open` → DSH 自注册协议 → 第二实例锁 → focusPrimaryWindow()
 *
 * 为什么 spawn 必须删 ELECTRON_RUN_AS_NODE：宿主自己就被这个变量以纯 Node 模式拉着跑，透传给
 * `dsh://` 的处理程序（DSH exe）会起出一个 node 进程，协议空转、窗口照旧不出现（issue #63 同一个坑）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { apply, dshOpenCommand, revealDesktopWindow, windowsFocusScript } from './index.ts';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const host = readSource('./index.ts');
const clientNotify = readSource('../client/notify.ts');
const clientApp = readSource('../client/app.ts');
const settings = readSource('../client/settings.ts');

describe('点击通知唤起 DSH 桌面窗口', () => {
  test('平台命令：三平台都落到 dsh://open，未知平台不下手', () => {
    assert.deepEqual(dshOpenCommand('win32'), { command: 'cmd.exe', args: ['/c', 'start', '', 'dsh://open'] });
    assert.deepEqual(dshOpenCommand('darwin'), { command: 'open', args: ['dsh://open'] });
    assert.deepEqual(dshOpenCommand('linux'), { command: 'xdg-open', args: ['dsh://open'] });
    assert.equal(dshOpenCommand('aix'), undefined, '不认识的平台宁可不做，也不猜一条命令乱起进程');
  });

  test('非桌面宿主：no-op（不 spawn），浏览器宿主行为不变', () => {
    // 测试进程是纯 Node：process.versions.electron 取不到 → 非桌面宿主
    assert.equal(revealDesktopWindow(), false);
  });

  test('spawn 契约：删 ELECTRON_RUN_AS_NODE + 不许 detached', () => {
    assert.ok(
      /delete env\.ELECTRON_RUN_AS_NODE/.test(host),
      '必须删掉 ELECTRON_RUN_AS_NODE，否则 dsh:// 处理程序被起成 node 进程，协议空转（issue #63）',
    );
    assert.ok(
      /spawn\(command, args, \{ stdio: 'ignore', windowsHide: true, env \}\)/.test(host),
      'ignore + windowsHide + unref：起完就撒手，不拖住宿主',
    );
    assert.ok(
      !/\{\s*detached: true/.test(host),
      '不许 detached：Windows 上 DETACHED_PROCESS 与 CREATE_NO_WINDOW 撞车——实测同一段脚本 detached 版连日志都写不出来',
    );
    assert.ok(/child\.once\('error'/.test(host), "spawn 失败异步 emit 'error'：不监听会升级成未捕获异常直接崩掉宿主");
  });

  test('Windows 抢前台：TOPMOST 顶最前 + SwitchToThisWindow 拿焦点', () => {
    // 前台锁：dsh:// 只能 restore+focus，实测窗口回来了仍被别的窗口盖着（用户报的「不置顶」）
    assert.ok(
      /\[DshPet\.W\]::SwitchToThisWindow\(\$h, \$true\)/.test(host),
      'Windows 必须用 SwitchToThisWindow 抢前台——SetForegroundWindow 会被前台锁拒绝',
    );
    assert.ok(
      /SetWindowPos\(\$h, \[IntPtr\]\(-1\)[\s\S]*?SetWindowPos\(\$h, \[IntPtr\]\(-2\)/.test(host),
      '「被遮挡」（非最小化）只能靠 TOPMOST → NOTOPMOST 顶到最前：实测记事本挡着 DSH 时有效',
    );
    assert.ok(/ShowWindow\(\$h, 9\)/.test(host), '最小化的窗口要先 SW_RESTORE');
    assert.ok(
      /powershellExe[\s\S]*?WindowsPowerShell/.test(host),
      'powershell 走绝对路径：宿主 PATH 不保证含它，spawn 静默 ENOENT 是最难查的失败',
    );
    assert.ok(
      /process\.platform === 'win32'[\s\S]*?windowsFocusScript\(exe, revealLogPath\(\)\)/.test(host),
      '只在 win32 走这条 PowerShell 绕法（macOS 的 open / Linux 的 xdg-open 不需要）',
    );
    assert.ok(
      /const hostExeName = \(\): string => basename\(process\.execPath, '\.exe'\)/.test(host),
      '窗口按宿主 exe 名找（host 自己就是那个 exe 以 ELECTRON_RUN_AS_NODE 起的），不许硬编码进程名',
    );
  });

  test('windowsFocusScript：纯函数，进程名与日志路径都转义到位', () => {
    const script = windowsFocusScript("DeepSeek Harness's");
    assert.ok(script.includes("DeepSeek Harness''s"), 'PowerShell 单引号字符串里的单引号必须翻倍转义');
    assert.ok(script.includes('MainWindowHandle -ne 0'), '没窗口的进程要跳过（否则 MainWindowHandle=0 会乱指）');
    assert.ok(!script.includes('undefined'), '参数缺失不许把 undefined 拼进脚本');

    const withLog = windowsFocusScript('X', "C:\\a'b\\reveal.log");
    assert.ok(withLog.includes("C:\\a''b\\reveal.log"), '日志路径同样要按 PowerShell 规则转义');
    assert.ok(withLog.includes('Add-Content -LiteralPath'), '传了日志路径就要写诊断行（区分"没找到窗口"）');
  });

  test('宿主路由：POST /reveal 才唤起，其余方法 405', () => {
    assert.ok(
      /if \(rest === 'reveal'\) \{[\s\S]*?method !== 'POST'[\s\S]*?revealed: revealDesktopWindow\(ctx\.logger\)/.test(
        host,
      ),
      'reveal 路由必须只认 POST 且把结果如实回给调用方',
    );
  });

  test('浏览器半侧：两处发通知都接同一个点击处理，且打到 /reveal', () => {
    assert.ok(
      /export function wireNotificationClick\(n: Notification, sessionId\?: string\): void \{[\s\S]*?fetch\('\/dsh-pet-7340\/reveal', \{ method: 'POST' \}\)/.test(
        clientNotify,
      ),
      '点击处理必须 POST /reveal（浏览器宿主下 window.focus() 是另一条腿，两者都要）',
    );
    assert.ok(
      /wireNotificationClick\(n, sessionId\)/.test(clientNotify),
      '事件通知必须走同一个点击处理，不许自己再写一份 onclick',
    );
    assert.ok(
      /liveNotifications\.add\(n\)/.test(clientNotify),
      '通知对象必须被强引用持有：Chromium 侧对象被 GC 后点击回调可能再也收不到（「点了没反应」的成因之一）',
    );
    assert.ok(
      /wireNotificationClick\(\s*new Notification\('测试通知'/.test(settings),
      '设置页「测试弹窗」是同一类通知，点击行为必须一致（否则测出来的链路和真实通知不是一条）',
    );
  });
});

describe('点击通知跳到对应会话', () => {
  test('client：帧里的 sessionId → 页内 uiWorkspace.openSession，再唤起窗口', () => {
    assert.ok(
      /if \(sessionId !== undefined\) openSessionInPage\(sessionId\);\s*\n\s*window\.focus\(\);/.test(clientNotify),
      '必须先切会话再叫窗口回前台（顺序反了用户会先看到旧会话）',
    );
    assert.ok(
      /sessionNavigator\.openSession\(sessionId\)/.test(clientNotify),
      '切会话只能经注入的跳转器——notify.ts 不直接摸 DSH 服务，取不到时天然退化成不跳会话',
    );
    assert.ok(
      /typeof frame\.sessionId === 'string' \? frame\.sessionId : undefined/.test(clientNotify),
      'toast 链要把帧里的 sessionId 一路透传到点击处理',
    );
    assert.ok(
      /get\?\.\('uiWorkspace'\)\?\.openSession\?\.\(sessionId\)/.test(clientApp),
      'app.ts 必须把 DSH 客户端的 uiWorkspace 服务包成跳转器注入（惰性取值：服务可能晚注册/旧版没有）',
    );
  });

  // 「对话完成」走活动门（issue #114）：先挂 1.5s 定时器确认这条会话没活了才推帧，
  // 所以这条用例要等它落地——而它恰恰是最常被点的通知，必须验证这条路径也带会话 id。
  test('host：活动门延迟路径（「对话完成」）也带会话 id', async () => {
    const h = setupNotifyHarness();
    try {
      h.emit(
        { id: 'session-abc', header: { id: 'session-abc', delegationDepth: 0 } },
        {
          type: 'turn/end',
          data: { reason: { kind: 'completed' } },
        },
      );
      const frame = await waitFrame(h);
      assert.equal(frame?.type, 'session/event');
      assert.equal(frame?.sessionId, 'session-abc', '帧必须带会话 id，否则点击只能唤起窗口、跳不到会话');
    } finally {
      h.dispose();
    }
  });

  test('host：不过活动门的即时路径（权限申请 / 生成失败）同样带会话 id', async () => {
    const h = setupNotifyHarness();
    try {
      h.emit({ header: { id: 'session-def' } }, { type: 'approval/asked', data: { toolName: 'pwsh' } });
      const frame = await h.frame();
      assert.equal(frame?.type, 'approval/requested');
      assert.equal(frame?.sessionId, 'session-def', '即时路径也要带（sessionIdOf 取 header.id 优先）');
    } finally {
      h.dispose();
    }
  });

  test('host：拿不到真会话 id 时帧照发（sessionIdOf 的 unknown 哨兵不许写进帧）', async () => {
    const h = setupNotifyHarness();
    try {
      h.emit({}, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } });
      const frame = await h.frame();
      assert.equal(frame?.type, 'session/event', '取不到 id 也必须发通知');
      assert.equal('sessionId' in (frame ?? {}), false, 'unknown 不是真会话，写进帧会让点击跳到一个不存在的会话');
    } finally {
      h.dispose();
    }
  });
});

// ---------- 最小插件实例（与 work-status-lifecycle.test.ts 同一套桩思路） ----------

/** 最小响应桩：writeHead 记状态码，Writable 收集 body */
class FakeRes extends Writable {
  declare status: number;
  declare chunks: Buffer[];
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

type NotifyHarness = {
  emit: (session: unknown, event: unknown) => void;
  frame: () => Promise<Record<string, unknown> | null>;
  dispose: () => void;
};

/** 起一个全新插件实例：喂 session/event → 读 S 里 sections.notify 的帧 */
function setupNotifyHarness(): NotifyHarness {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const listeners: Array<(session: unknown, event: unknown) => void> = [];
  const disposers: Array<() => void> = [];
  const noop = (): void => {};
  apply({
    effect: (fn: () => unknown) => {
      try {
        const ret = fn();
        if (typeof ret === 'function') disposers.push(ret as () => void);
        return ret;
      } catch {
        /* 源码形态下内置配置不可达：吞掉，不影响监听注册 */
      }
    },
    on: (name: string, cb: (session: unknown, event: unknown) => void) => {
      if (name === 'session/event') listeners.push(cb);
      return noop;
    },
    webServer: { register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop) },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    agentDefaultModel: { currentSelection: () => undefined },
    credentials: { resolve: async () => undefined },
  });
  assert.ok(handler, 'apply() 应注册 /dsh-pet-7340 prefix handler');
  return {
    emit: (session, event) => {
      for (const listener of listeners) listener(session, event);
    },
    frame: () =>
      new Promise((done) => {
        const res = new FakeRes();
        res.on('finish', () => {
          const body = JSON.parse(Buffer.concat(res.chunks).toString('utf8')) as {
            sections?: { notify?: { data?: Record<string, unknown> | null } };
          };
          done(body.sections?.notify?.data ?? null);
        });
        void handler?.({ method: 'GET', url: '/dsh-pet-7340/state', on: noop }, res);
      }),
    dispose: () => {
      // 释放插件注册的 effect（余额周期定时器是常驻的）：不释放测试进程跑完不退出
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          /* 收尾失败不影响断言 */
        }
      }
    },
  };
}

/** 等通知帧落地：活动门那条路径要 1.5s 之后才推帧，读一次是不够的 */
async function waitFrame(h: NotifyHarness, timeoutMs = 4000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await h.frame();
    if (frame) return frame;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let tmpHome = '';
let savedHome: string | undefined;

before(() => {
  savedHome = process.env.DSH_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'dsh-pet-reveal-'));
  process.env.DSH_HOME = tmpHome;
});

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});
