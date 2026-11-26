const {TextReader, Uint8ArrayWriter, ZipWriter} = require('@zip.js/zip.js');

async function makeDocx(body) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), {useWebWorkers:false});
  await zip.add('[Content_Types].xml', new TextReader(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>',
  ));
  await zip.add('_rels/.rels', new TextReader(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>',
  ));
  await zip.add('word/document.xml', new TextReader(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`,
  ));
  return Buffer.from(await zip.close());
}

module.exports = {makeDocx};
