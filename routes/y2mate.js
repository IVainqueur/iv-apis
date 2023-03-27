const app = require('express').Router()
const axios = require('axios');

app.get('/versions', (req, res) => {
    const { id } = req.query;
    console.log("[log] Versions requested for ID: " + `\x1B[33m\x1B[1m${id}\x1B[0m`)
    if (!id) return res.status(400).send("No ID provided");

    axios.request(
        {
            url: 'https://www.y2mate.com/mates/analyzeV2/ajax',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: `k_query=https://www.youtube.com/watch?v=${id}`,
        }).then(({ data }) => {
            res.send(data ?? {
                code: "#Error",
                message: "No data found"
            })
        }).catch((e) => {
            res.status(500).send(e.message)
        })
})

app.get('/downloadlink', (req, res) => {
    const { y2mate_id, id, download } = req.query;
    if (!y2mate_id || !id) return res.status(400).send("No id and/or y2mate_id provided");

    console.log({
        y2mate_id: encodeURIComponent(y2mate_id),
        id: encodeURIComponent(id)
    })

    axios.request(
        {
            url: 'https://www.y2mate.com/mates/convertV2/index',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: `vid=${encodeURIComponent(id)}&k=${encodeURIComponent(y2mate_id.split(" ").join('+'))}`,
        }
    )
    .then(({ data }) => {
        console.log(data)
        if(download && data.status === "ok") {
            return res.redirect(data.dlink)
        }
        res.send(data)
    }
    ).catch((e) => {
        res.status(500).send(e.message)
    }
    )
})


module.exports = app
