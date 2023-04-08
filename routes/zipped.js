const app = require('express').Router()
const http = require('http')
const https = require('https')
const fs = require('fs');
const path = require('path');
const { default: axios } = require('axios');
const uuid = require('short-uuid').generate;
const JSZip = require('jszip');

app.post('/zip', async (req, res) => {
    try{
        const { items, zip_name } = req.body;
    const { download } = req.query;

    if (!items) return res.status(400).send("No items provided")
    if (!Array.isArray(items)) return res.status(400).send("Items must be an array")
    if (items.length < 1) return res.status(400).send("Items array must have atleast one item")

    const folderName = uuid();
    const zipName = zip_name || folderName;
    fs.mkdirSync(path.join(__dirname, `../tmp/${folderName}`), { recursive: true })

    const zip = new JSZip();

    for (const item of items) {
        if(!item.url) continue;
        if (!item.url.startsWith("https://") && !item.url.startsWith("http://")) continue;

        try {
            const response = await axios.get(item.url, { responseType: 'arraybuffer' })
            zip.file(encodeURIComponent(item.name) || uuid(), response.data)

            console.log("[log] got item: " + `\x1B[33m\x1B[1m${item.name}\x1B[0m`)
        } catch (e) {
            console.log("[log] error while getting item: " + `\x1B[33m\x1B[1m${item.name}\x1B[0m`)
        }
    }
    console.log('[log] the items array in the body -> ', items)

    const zipDir = path.join(__dirname, `../tmp/${folderName}/${zipName}.zip`)
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
        .pipe(fs.createWriteStream(zipDir))
        .on('finish', function () {
            console.log("[log] zip file generated")

            if (download) res.redirect(`/zipped/download/${folderName}/${zipName}.zip`)
            else res.send(`/zipped/download/${folderName}/${zipName}.zip`)

            setTimeout(() => {
                try {
                    if (!fs.existsSync(`../tmp/${folderName}`)) return
                    fs.rmSync(path.join(__dirname, `../tmp/${folderName}`), { recursive: true, force: true })
                } catch (e) {

                }
            }, 1000 * 60 * 10)

        });

    }catch(e) {
        console.log("[log] error while zipping: " + `\x1B[33m\x1B[1m${e.message}\x1B[0m`)
        res.send("Error while zipping")
    }

});

app.get('/download/:folder/:file', (req, res) => {
    const { folder, file } = req.params;
    const fileDir = path.join(__dirname, `../tmp/${folder}/${file}`);
    if (!fs.existsSync(fileDir)) return res.status(404).send("File not found")

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=${fileDir}`);
    const filestream = fs.createReadStream(fileDir);
    filestream.pipe(res);

    filestream.on('end', () => {
        try {
            fs.rmSync(path.join(__dirname, `../tmp/${folder}`), { recursive: true, force: true })
        } catch (e) {

        }
    })
})

module.exports = app
