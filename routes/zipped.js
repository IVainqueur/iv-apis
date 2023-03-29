const app = require('express').Router()
const http = require('http')
const https = require('https')
const fs = require('fs');
const path = require('path');
const { default: axios } = require('axios');
const uuid = require('short-uuid').generate;
const JSZip = require('jszip');

app.post('/zip', async (req, res) => {
    const { items, zip_name } = req.body;

    if (!items) return res.status(400).send("No items provided")
    if (!Array.isArray(items)) return res.status(400).send("Items must be an array")
    if (items.length < 1) return res.status(400).send("Items array must have atleast one item")

    const folderName = uuid();
    const zipName = zip_name || folderName;
    fs.mkdirSync(path.join(__dirname, `../tmp/${folderName}`), { recursive: true })

    const zip = new JSZip();

    for (const item of items) {
        if (!item.url.startsWith("https://") && !item.url.startsWith("http://")) continue;

        const response = await axios.get(item.url, { responseType: 'arraybuffer' })
        zip.file(item.name, response.data)

        console.log("[log] got item: " + `\x1B[33m\x1B[1m${item}\x1B[0m`)
    }
    console.log('[log] the items array in the body -> ', items)

    const zipDir = path.join(__dirname, `../tmp/${folderName}/${zipName}.zip`)
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
        .pipe(fs.createWriteStream(zipDir))
        .on('finish', function () {
            console.log("[log] zip file generated")
            res.set('Content-Type', 'application/zip');
            res.set('Content-Disposition', `attachment; filename=${zipDir}`);
            const filestream = fs.createReadStream(zipDir);
            filestream.pipe(res);

            filestream.on('end', () => {
                fs.rmSync(path.join(__dirname, `../tmp/${folderName}`), { recursive: true })
            })
        });


});

module.exports = app
