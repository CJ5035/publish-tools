import { describe, it, expect } from "vitest";
import { classifyWpfDlls } from "./wpfDllClassify";

describe("classifyWpfDlls", () => {
  it("SIE.Wpf.MES.dll -> UI", () => {
    const r = classifyWpfDlls(["SIE.Wpf.MES.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.MES.dll"]);
    expect(r.Domain).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("大小写不敏感 WPF -> UI", () => {
    const r = classifyWpfDlls(["SIE.WPF.Items.dll", "sIE.wpf.x.dll"]);
    expect(r.UI).toEqual(["SIE.WPF.Items.dll", "sIE.wpf.x.dll"]);
  });

  it("WPF 出现在任意位置 -> UI", () => {
    const r = classifyWpfDlls(["MyWPFTool.dll"]);
    expect(r.UI).toEqual(["MyWPFTool.dll"]);
  });

  it("同时含 WPF 和 WEB -> UI (WPF优先)", () => {
    const r = classifyWpfDlls(["SIE.WPF.Web.dll"]);
    expect(r.UI).toEqual(["SIE.WPF.Web.dll"]);
    expect(r.skipped).toEqual([]);
  });

  it("含 WEB -> skipped", () => {
    const r = classifyWpfDlls(["SIE.Web.Client.dll", "webportal.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.Client.dll", "webportal.dll"]);
  });

  it("大小写不敏感 WEB -> skipped", () => {
    const r = classifyWpfDlls(["SIE.WEB.Api.dll", "MyWeb.dll"]);
    expect(r.skipped).toContain("SIE.WEB.Api.dll");
    expect(r.skipped).toContain("MyWeb.dll");
  });

  it("其余 -> Domain", () => {
    const r = classifyWpfDlls(["SIE.Common.dll", "SIE.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll", "SIE.dll"]);
  });

  it("第三方 DevExpress.Xpf 含 Xpf 但不含 WPF -> Domain", () => {
    const r = classifyWpfDlls(["DevExpress.Xpf.Grid.v19.1.dll"]);
    expect(r.Domain).toEqual(["DevExpress.Xpf.Grid.v19.1.dll"]);
  });

  it("入参为完整 Windows/Unix 路径时取文件名", () => {
    const r = classifyWpfDlls([
      "C:\\publish\\WpfClient\\SIE.Wpf.A.dll",
      "/home/publish/WpfClient/SIE.Common.dll",
      "C:\\publish\\WpfClient\\SIE.Web.B.dll",
    ]);
    expect(r.UI).toEqual(["SIE.Wpf.A.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.B.dll"]);
  });

  it("空数组", () => {
    const r = classifyWpfDlls([]);
    expect(r).toEqual({ Domain: [], UI: [], skipped: [] });
  });

  it("同名去重", () => {
    const r = classifyWpfDlls(["SIE.Common.dll", "SIE.Common.dll", "SIE.Wpf.A.dll", "SIE.Wpf.A.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
    expect(r.UI).toEqual(["SIE.Wpf.A.dll"]);
  });

  it("去重对路径归一化后的同名也去重", () => {
    const r = classifyWpfDlls(["C:\\a\\SIE.Common.dll", "/b/SIE.Common.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll"]);
  });

  it("混合完整场景", () => {
    const r = classifyWpfDlls([
      "SIE.Wpf.MES.dll",
      "SIE.Common.dll",
      "SIE.Web.Client.dll",
      "MyWPFTool.dll",
      "SIE.WPF.Web.dll",
      "SIE.dll",
    ]);
    expect(r.UI).toEqual(["SIE.Wpf.MES.dll", "MyWPFTool.dll", "SIE.WPF.Web.dll"]);
    expect(r.Domain).toEqual(["SIE.Common.dll", "SIE.dll"]);
    expect(r.skipped).toEqual(["SIE.Web.Client.dll"]);
  });
});
