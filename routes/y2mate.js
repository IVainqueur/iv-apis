const app = require('express').Router()
const axios = require('axios');

app.get('/versions', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send("No ID provided");
    axios.post(`https://www.y2mate.com/mates/analyzeV2/ajax`, {
        Headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: JSON.stringify({
            k_query: `https://www.youtube.com/watch?v=${id}`,
        })
    }).then(({ data }) => {
        res.send(data)
    }).catch((e) => {
        res.status(500).send(e.message)
    })
})

app.get('/download', (req, res) => {
    const { y2mate_id, id } = req.query;
    if (!y2mate_id || !id) return res.status(400).send("No id and/or y2mate_id provided");

    axios.post(`https://www.y2mate.com/mates/convertV2/ajax`, {
        Headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: JSON.stringify({
            vid: id,
            k: y2mate_id,
        })
    }).then(({ data }) => {
        res.send(data)
    }
    ).catch((e) => {
        res.status(500).send(e.message)
    }
    )
})

module.exports = app
