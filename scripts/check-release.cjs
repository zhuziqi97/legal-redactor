const assert = require('node:assert/strict');
const {access, mkdir, mkdtemp, readFile, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {_electron} = require('playwright');
const {makeDocx} = require('../tests/docx-fixture.cjs');

async function main(executable, version) {
  const profile = await mkdtemp(join(tmpdir(), 'legal-redactor-release-'));
  const env = {...process.env, REDACTOR_USER_DATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.REDACTOR_RULES_ONLY;
  delete env.REDACTOR_ONNX_DIR;
  let desktop;
  try {
    await mkdir(join(profile, 'preferences'));
    await writeFile(join(profile, 'preferences', 'settings.json'), JSON.stringify({
      inference: {provider:'cpu'}, updates: {automatic:false},
    }));
    desktop = await _electron.launch({
      executablePath:resolve(executable), env, timeout:60000,
      args:process.platform === 'linux' ? ['--no-sandbox'] : [],
    });
    const {resources, ...info} = await desktop.evaluate(({app}) => ({
      packaged:app.isPackaged, version:app.getVersion(), resources:process.resourcesPath,
    }));
    assert.deepEqual(info, {packaged:true, version});
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(90000);
    const runtime = join(resources, 'app', 'node_modules', 'onnxruntime-node');
    const {requirements, manifests} = require(join(runtime, 'script', 'install-metadata.js'));
    const target = `${process.platform}/${process.arch}`;
    const binaryDirectory = join(runtime, 'bin', 'napi-v6', target);
    for (const installation of requirements[target] ?? []) {
      const files = Object.keys(manifests[`${target}:${installation}`]);
      await Promise.all(files.map(file => access(join(binaryDirectory, file))));
    }
    const expectedBackends = require(runtime).listSupportedBackends().map(backend => backend.name).sort();
    const settingsBackends = await page.evaluate(async () => (await window.redaction.settingsInfo()).backends);
    assert.deepEqual(settingsBackends.filter(backend => backend !== 'auto').sort(), expectedBackends);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const sourcePath = join(profile, '离线测试.docx');
    const sourceText = '姓名：\n张甲\n联系电话：13800138000\n业务流水号：2031021800004271\n'
      + '统一社会信用代码：91000000MA0REDAC1X\n备注：材料已核对。';
    await writeFile(sourcePath, await makeDocx(sourceText.split('\n')
      .map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')));
    await desktop.evaluate(({dialog}, path) => {
      dialog.showOpenDialog = async () => ({canceled:false, filePaths:[path]});
    }, sourcePath);
    await page.getByRole('tabpanel', {name:'脱敏'}).getByRole('button', {name:'添加文本材料', exact:true}).click();
    const input = page.getByRole('dialog', {name:'添加文本材料', exact:true});
    await input.getByRole('button', {name:'打开文件', exact:true}).click();
    await input.getByText('离线测试.docx', {exact:true}).waitFor();
    const preview = input.getByLabel('正文预览');
    assert.equal(await preview.inputValue(), sourceText);
    assert.equal(await preview.isEditable(), false);
    await input.getByRole('button', {name:'添加并识别', exact:true}).click();

    const exportPath = join(profile, '脱敏.txt');
    await desktop.evaluate(({dialog}, filePath) => {
      dialog.showSaveDialog = async () => ({canceled:false, filePath});
    }, exportPath);
    await page.locator('#output-pane').getByRole('button', {name:'导出 TXT', exact:true}).click();
    await page.locator('#redact-panel').getByRole('status').getByText('已导出 TXT', {exact:true}).waitFor();
    const output = await readFile(exportPath, 'utf8');
    assert.doesNotMatch(output, /张甲|13800138000|91000000MA0REDAC1X/u);
    assert.match(output, /姓名：\n【张某】/u);
    assert.match(output, /业务流水号：2031021800004271\n统一社会信用代码：【信用代码1】/u);
    assert.match(output, /备注：材料已核对。/u);
    assert.equal(output, await page.locator('#output-text').textContent());
    const diagnostics = (await readFile(join(profile, 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(diagnostics.some(row => row.stage === 'analysis' && row.native && row.evaluated > 0));
    assert.deepEqual(pageErrors, []);
    console.log(`LegalRedactor ${version} · ${process.platform} ${process.arch} · backend bundle, DOCX import, CPU inference and TXT export passed.`);
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
