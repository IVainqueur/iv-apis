const app = require('express').Router()
const axios = require('axios');

const QUALITIES = [
    "mp3",
    "144p",
    "240p",
    "360p",
    "480p",
    "720p",
    "1080p",
]

app.get('/versions', (req, res) => {
    const { link } = req.query;
    console.log("[log] Versions requested for Link: " + `\x1B[33m\x1B[1m${link}\x1B[0m`)
    if (!link) return res.status(400).send("No Link provided");

    axios.request(
        {
            url: 'https://www.y2mate.com/mates/analyzeV2/ajax',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: `k_query=${link}`,
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
            if (data.status !== "ok") throw new Error('Error while getting download link')
            if (download && data.status === "ok") {
                return res.redirect(data.dlink)
            }
            res.send(data)
        })
        .catch((e) => {
            res.status(500).send(e.message)
        })
})

app.get("/downloadplaylist", async (req, res) => {
    let { link, quality, albumName } = req.query;

    const HOME_URI = req.protocol + '://' + req.get('host')

    if (!link) return res.status(400).send("No Link provided");
    if (!QUALITIES.includes(quality)) quality = "mp3";

    try {
        const playlist = await axios.request({
            url: `${HOME_URI}/y2mate/versions?link=${link}`,
            method: 'GET',
        })

        if (playlist.data.status != "ok") throw new Error("Error while getting playlist")
        if (playlist.data.page !== "playlist") throw new Error("Not a playlist")

        const zipName = playlist.data.title;
        const videos = playlist.data.vitems.map(item => ({ name: item.t, id: item.v }));

        await (new Promise((resolve, reject) => {
            let done = 0;
            videos.forEach((video, index) => {
                axios.request({
                    url: `${HOME_URI}/y2mate/versions?link=https://youtube.com/watch?v=${video.id}`,
                    method: 'GET',
                })
                    .then(({ data }) => {
                        if (data.status !== "ok") throw new Error('Error while getting download link')
                        const { mp4: mp4s, mp3: mp3s } = data.links;

                        videos[index].tags = {
                            title: video.name.replace(/(\s?\(?\s?(?:Official)(?:lyric)??.*?(?:audio|video)\)?\s?)/gi, ''),
                            artist: data.a,
                            album: albumName ?? playlist.data.title,
                            APIC:  `https://nigen.vercel.app/api/cropImage?baseWidth=500&aspectRatio=1:1&imgURL=https://i3.ytimg.com/vi/${data.vid}/maxresdefault.jpg`
                        }

                        if (quality === "mp3") {
                            const k = Object.values(mp3s).find(el => el.f === "mp3");
                            if (!k) throw new Error("No mp3 found")
                            return axios.request({
                                url: `${HOME_URI}/y2mate/downloadlink?y2mate_id=${k.k}&id=${video.id}`,
                                method: 'GET'
                            })
                        }
                        let k = ""
                        for (const qual of Object.values(mp4s)) {
                            if (qual.q === quality) {
                                k = qual.k
                                break;
                            }
                        }
                        if (k === "") k = Object.values(mp4s)[0].k;

                        return axios.request({
                            url: `${HOME_URI}/y2mate/downloadlink?y2mate_id=${k}&id=${video.id}`,
                            method: 'GET'
                        })

                    })
                    .then(({ data }) => {
                        if (data.status !== "ok") throw new Error('Error while getting download link')
                        videos[index].url = data.dlink
                        videos[index].name += "" + (quality === "mp3" ? ".mp3" : ".mp4")

                    })
                    .catch((e) => {
                        console.log("ERROR: " + e.message)
                        console.log('Failed to get download link for video: ' + video.name + ' (' + video.id + ')')
                    })
                    .finally(() => {
                        done++;
                        if (done === videos.length) resolve();
                    })


            })
        }))

        console.log("Here are the video tags: ", videos.map(el => el.tags))

        axios.request({
            url: `${HOME_URI}/zipped/zip`,
            method: "POST",
            data: {
                zipName,
                items: videos
            }
        })
            .then(({ data }) => {
                res.redirect(data)
            })


    } catch (e) {
        res.status(500).send(e.message)
    }
})


module.exports = app
