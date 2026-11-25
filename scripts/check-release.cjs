const assert = require('node:assert/strict');
const {mkdtemp, readFile, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {_electron} = require('playwright');

async function main(executable, version) {
  const profile = await mkdtemp(join(tmpdir(), 'legal-redactor-release-'));
  const env = {...process.env, REDACTOR_USER_DATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.REDACTOR_RULES_ONLY;
  delete env.REDACTOR_ONNX_DIR;
  let desktop;
  try {
    await writeFile(join(profile, 'inference-settings.json'), '{"provider":"cpu"}');
    desktop = await _electron.launch({
      executablePath:resolve(executable), env, timeout:60000,
      args:process.platform === 'linux' ? ['--no-sandbox'] : [],
    });
    const info = await desktop.evaluate(({app}) => ({packaged:app.isPackaged, version:app.getVersion()}));
    assert.deepEqual(info, {packaged:true, version});
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(90000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByRole('button', {name:'添加材料', exact:true}).click();
    const input = page.getByRole('dialog', {name:'添加材料', exact:true});
    await input.getByLabel('材料名称').fill('离线测试');
    await input.getByLabel('材料原文').fill('姓名：张甲\n联系电话：13800138000\n备注：材料已核对。');
    await input.getByRole('button', {name:'添加并识别', exact:true}).click();

    const exportPath = join(profile, '脱敏.txt');
    await desktop.evaluate(({dialog}, filePath) => {
      dialog.showSaveDialog = async () => ({canceled:false, filePath});
    }, exportPath);
    await page.locator('#output-pane').getByRole('button', {name:'导出 TXT', exact:true}).click();
    await page.locator('#redact-panel').getByRole('status').getByText('已导出 TXT', {exact:true}).waitFor();
    const output = await readFile(exportPath, 'utf8');
    assert.doesNotMatch(output, /张甲|13800138000/u);
    assert.match(output, /备注：材料已核对。/u);
    assert.equal(output, await page.locator('#output-text').textContent());
    const diagnostics = (await readFile(join(profile, 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(diagnostics.some(row => row.stage === 'analysis' && row.native && row.evaluated > 0));
    assert.deepEqual(pageErrors, []);
    console.log(`LegalRedactor ${version} · ${process.platform} ${process.arch} · bundled CPU inference and actual TXT export passed.`);
  } catch (error) {
    const page = desktop?.windows()[0];
    if (page) console.error(await page.locator('#redact-panel').getByRole('status').allTextContents().catch(() => []));
    throw error;
  } finally {
    await desktop?.evaluate(({app}) => app.exit(0)).catch(() => {});
    await rm(profile, {recursive:true, force:true, maxRetries:4});
  }
}

main(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
