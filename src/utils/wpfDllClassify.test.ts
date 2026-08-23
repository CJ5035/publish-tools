import { describe, it, expect } from "vitest";
import { classifyWpfDlls } from "./wpfDllClassify";

describe("classifyWpfDlls — 五分支 SIE 规则（分支顺序不可调换）", () => {
  it("SIE.Wpf.MES.dll → UI", () => {
    const r = classifyWpfDlls(["SIE.Wpf.MES.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.MES.dll"]);
    expect(r.Domain).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("大小写不敏感 sie.wpf.x.dll → UI", () => {
    const r = classifyWpfDlls(["sie.wpf.x.dll"]);
    expect(r.UI).toEqual(["sie.wpf.x.dll"]);
  });

  it("大小写不敏感 SIE.WPF.Items.dll → UI", () => {
    const r = classifyWpfDlls(["SIE.WPF.Items.dll"]);
    expect(r.UI).toEqual(["SIE.WPF.Items.dll"]);
  });

  it("裸名 SIE.Wpf.dll → skipped（陷阱：不得落入 Domain）", () => {
    const r = classifyWpfDlls(["SIE.Wpf.dll"]);
    expect(r.skipped).toEqual(["SIE.Wpf.dll"]);
    expect(r.UI).toEqual([]);
    expect(r.Domain).toEqual([]);
  });

  it("裸名 SIE.Wpf.dll 大小写变体 → skipped", () => {
    const r = classifyWpfDlls(["sie.wpf.dll", "SIE.WPF.DLL", "Sie.Wpf.Dll"]);
    expect(r.skipped).toEqual(["sie.wpf.dll", "SIE.WPF.DLL", "Sie.Wpf.Dll"]);
    expect(r.Domain).toEqual([]);
  });

  it("裸名 SIE.dll → skipped", () => {
    const r = classifyWpfDlls(["SIE.dll"]);
    expect(r.skipped).toEqual(["SIE.dll"]);
    expect(r.Domain).toEqual([]);
  });

  it("裸名 SIE.DLL 大小写变体 → skipped", () => {
    const r = classifyWpfDlls(["sie.dll", "SIE.DLL"]);
    expect(r.skipped).toEqual(["sie.dll", "SIE.DLL"]);
  });

  it("SIE.Web.ProductIntfc.dll → skipped（WEB 兜底分支）", () => {
    const r = classifyWpfDlls(["SIE.Web.ProductIntfc.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.ProductIntfc.dll"]);
    expect(r.UI).toEqual([]);
    expect(r.Domain).toEqual([]);
  });

  it("WEB 分支大小写不敏感 sie.web.api.dll → skipped", () => {
    const r = classifyWpfDlls(["sie.web.api.dll", "SIE.WEB.Api.dll"]);
    expect(r.skipped).toEqual(["sie.web.api.dll", "SIE.WEB.Api.dll"]);
  });

  it("SIE.Wpf. 优先于 WEB：SIE.Wpf.Web.dll → UI", () => {
    const r = classifyWpfDlls(["SIE.Wpf.Web.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.Web.dll"]);
    expect(r.skipped).toEqual([]);
  });

  it("SIE.Common.dll → Domain", () => {
    const r = classifyWpfDlls(["SIE.Common.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
    expect(r.skipped).toEqual([]);
    expect(r.UI).toEqual([]);
  });

  it("SIE.ZhongHeng.Interface.dll → Domain", () => {
    const r = classifyWpfDlls(["SIE.ZhongHeng.Interface.dll"]);
    expect(r.Domain).toEqual(["SIE.ZhongHeng.Interface.dll"]);
  });

  it("第三方含 Wpf 字样 Stimulsoft.Report.Wpf.dll / CefSharp.Wpf.dll → skipped", () => {
    const r = classifyWpfDlls(["Stimulsoft.Report.Wpf.dll", "CefSharp.Wpf.dll"]);
    expect(r.skipped).toEqual(["Stimulsoft.Report.Wpf.dll", "CefSharp.Wpf.dll"]);
    expect(r.UI).toEqual([]);
    expect(r.Domain).toEqual([]);
  });

  it("第三方 DevExpress.Xpf.Grid.v19.1.dll / Newtonsoft.Json.dll → skipped", () => {
    const r = classifyWpfDlls(["DevExpress.Xpf.Grid.v19.1.dll", "Newtonsoft.Json.dll"]);
    expect(r.skipped).toEqual(["DevExpress.Xpf.Grid.v19.1.dll", "Newtonsoft.Json.dll"]);
    expect(r.Domain).toEqual([]);
  });

  it("更多第三方均 skipped（不在 SIE. 前缀范围）", () => {
    const r = classifyWpfDlls([
      "System.Data.dll",
      "NLog.dll",
      "WebView2Loader.dll",
      "Stimulsoft.Report.dll",
      "CefSharp.Core.dll",
    ]);
    expect(r.skipped).toHaveLength(5);
    expect(r.Domain).toEqual([]);
    expect(r.UI).toEqual([]);
  });

  it("含 Web 的第三方 → skipped（WEB 分支兜底）", () => {
    const r = classifyWpfDlls(["MyWebTool.dll", "SuperWebView.dll"]);
    expect(r.skipped).toEqual(["MyWebTool.dll", "SuperWebView.dll"]);
  });

  it("入参为完整 Windows 路径时取文件名", () => {
    const r = classifyWpfDlls([
      "C:\\publish\\WpfClient\\SIE.Wpf.A.dll",
      "C:\\publish\\WpfClient\\SIE.Common.dll",
      "C:\\publish\\WpfClient\\SIE.Web.B.dll",
      "C:\\publish\\WpfClient\\SIE.Wpf.dll",
      "C:\\publish\\WpfClient\\Newtonsoft.Json.dll",
    ]);
    expect(r.UI).toEqual(["SIE.Wpf.A.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.B.dll", "SIE.Wpf.dll", "Newtonsoft.Json.dll"]);
  });

  it("入参为完整 Unix 路径时取文件名", () => {
    const r = classifyWpfDlls([
      "/home/publish/WpfClient/SIE.Wpf.B.dll",
      "/home/publish/WpfClient/SIE.ZhongHeng.Interface.dll",
      "/home/publish/WpfClient/Stimulsoft.Report.Wpf.dll",
    ]);
    expect(r.UI).toEqual(["SIE.Wpf.B.dll"]);
    expect(r.Domain).toEqual(["SIE.ZhongHeng.Interface.dll"]);
    expect(r.skipped).toEqual(["Stimulsoft.Report.Wpf.dll"]);
  });

  it("混合分隔符路径", () => {
    const r = classifyWpfDlls(["C:/publish\\WpfClient/SIE.Wpf.MES.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.MES.dll"]);
  });

  it("空数组", () => {
    const r = classifyWpfDlls([]);
    expect(r).toEqual({ Domain: [], UI: [], skipped: [] });
  });

  it("空字符串与非法路径被忽略", () => {
    const r = classifyWpfDlls(["", "SIE.Common.dll", ""]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
  });

  it("同名去重（精确按 basename）", () => {
    const r = classifyWpfDlls(["SIE.Common.dll", "SIE.Common.dll", "SIE.Wpf.A.dll", "SIE.Wpf.A.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.A.dll"]);
  });

  it("去重对路径归一化后的同名也去重", () => {
    const r = classifyWpfDlls(["C:\\a\\SIE.Common.dll", "/b/SIE.Common.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
  });

  it("去重保留首次出现的原始文件名大小写", () => {
    const r = classifyWpfDlls(["C:\\a\\SIE.Common.dll", "SIE.COMMON.DLL"]);
    // 精确去重，大小写不同视为不同文件
    expect(r.Domain).toEqual(["SIE.Common.dll", "SIE.COMMON.DLL"]);
  });

  // ── 样本回归：中恒（代表性子集模拟全量数量验证） ──
  it("样本回归 — 中恒：38 UI + 100 Domain + 裸名/第三方跳过", () => {
    const uiNames = Array.from({ length: 38 }, (_, i) => `SIE.Wpf.Module${String(i + 1).padStart(2, "0")}.dll`);
    const domainNames = Array.from({ length: 100 }, (_, i) => `SIE.Domain${String(i + 1).padStart(3, "0")}.dll`);
    domainNames[0] = "SIE.Common.dll";
    domainNames[1] = "SIE.ZhongHeng.Interface.dll";
    domainNames[2] = "SIE.ObjectModel.dll";
    const skippedNames = [
      "SIE.dll",
      "SIE.Wpf.dll",
      "Stimulsoft.Report.Wpf.dll",
      "CefSharp.Wpf.dll",
      "DevExpress.Xpf.Grid.v19.1.dll",
      "Newtonsoft.Json.dll",
      "NLog.dll",
      "System.Data.dll",
    ];
    const all = [...uiNames, ...domainNames, ...skippedNames];
    const r = classifyWpfDlls(all);
    expect(r.UI).toHaveLength(38);
    expect(r.Domain).toHaveLength(100);
    expect(r.skipped).toHaveLength(skippedNames.length);
    expect(r.UI).toEqual(expect.arrayContaining(["SIE.Wpf.Module01.dll"]));
    expect(r.Domain).toEqual(expect.arrayContaining(["SIE.Common.dll", "SIE.ZhongHeng.Interface.dll"]));
    expect(r.skipped).toEqual(expect.arrayContaining(["SIE.dll", "SIE.Wpf.dll", "Stimulsoft.Report.Wpf.dll"]));
    expect(r.skipped).toContain("CefSharp.Wpf.dll");
    expect(r.UI).not.toContain("CefSharp.Wpf.dll");
  });

  // ── 样本回归：华俊（396 个 DLL，代表性子集） ──
  it("样本回归 — 华俊：42 UI + 107 Domain + 247 跳过（含 6 个 Wpf/4 个 Web 第三方）", () => {
    const uiNames = Array.from({ length: 42 }, (_, i) => `SIE.Wpf.HuaJun${String(i + 1).padStart(2, "0")}.dll`);
    const domainNames = Array.from({ length: 107 }, (_, i) => `SIE.HuaJunDomain${String(i + 1).padStart(3, "0")}.dll`);
    domainNames[0] = "SIE.Common.dll";
    domainNames[1] = "SIE.DataModel.dll";
    const wpfThirdParty = [
      "Stimulsoft.Report.Wpf.dll",
      "CefSharp.Wpf.dll",
      "Stimulsoft.Editor.Wpf.dll",
      "CefSharp.Wpf.HwndHost.dll",
      "Microsoft.Web.WebView2.Wpf.dll",
      "Some.Wpf.Toolkit.dll",
    ];
    const webThirdParty = ["SIE.Web.FakeExternal.dll", "MyWebView.dll", "SuperWebSocket.dll", "WebHelper.dll"];
    const otherThirdParty = Array.from({ length: 247 - 6 - 4 - 2 }, (_, i) => `ThirdParty.Lib${String(i + 1).padStart(3, "0")}.dll`);
    const skippedNames = ["SIE.dll", "SIE.Wpf.dll", ...wpfThirdParty, ...webThirdParty, ...otherThirdParty];
    const all = [...uiNames, ...domainNames, ...skippedNames];
    const r = classifyWpfDlls(all);
    expect(r.UI).toHaveLength(42);
    expect(r.Domain).toHaveLength(107);
    expect(r.skipped).toHaveLength(247);
    for (const name of wpfThirdParty) {
      expect(r.skipped).toContain(name);
      expect(r.UI).not.toContain(name);
    }
    for (const name of webThirdParty) {
      expect(r.skipped).toContain(name);
    }
    expect(r.skipped).toContain("SIE.dll");
    expect(r.skipped).toContain("SIE.Wpf.dll");
    expect(r.Domain).toContain("SIE.Common.dll");
  });

  it("混合完整场景 — 各分支一次覆盖", () => {
    const r = classifyWpfDlls([
      "SIE.Wpf.MES.dll", // UI 分支2
      "SIE.Common.dll", // Domain 分支4
      "SIE.Web.Client.dll", // skipped 分支3
      "SIE.dll", // skipped 分支1
      "SIE.Wpf.dll", // skipped 分支1 陷阱
      "Stimulsoft.Report.Wpf.dll", // skipped 分支5
      "Newtonsoft.Json.dll", // skipped 分支5
      "SIE.ZhongHeng.Interface.dll", // Domain
    ]);
    expect(r.UI).toEqual(["SIE.Wpf.MES.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll", "SIE.ZhongHeng.Interface.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.Client.dll", "SIE.dll", "SIE.Wpf.dll", "Stimulsoft.Report.Wpf.dll", "Newtonsoft.Json.dll"]);
  });
});
