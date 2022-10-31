const axios = require('axios');
const { nodups, githubHTML, githubSortLanguages } = require('../oneliners');
const app = require('express').Router()

const colorPairs = [
    ["#E71B18", "#18E4E7"],
    ["#711FE0", "#8EE01F"],
    ["#3AC53E", "#C53AC1"],
    ["#D7A428", "#285BD7"],
    ["#E916C9", "#16E936"],
    ["#FF00B2","#00FF4D"],
    ["#4530CF", "#ffffff"],
    ["#7A00FF", "#FFFFFF"],
    ["#F5820A", "#0A7DF5"],
    ["#8458A7", "#7BA758"]
]

const getrepos = async (username) => {
    const URI = `https://api.github.com/users/${username}/repos`;
    let results = [];
    let page = 1;
    while (true) {
        const url = URI + '?page=' + page;
        console.log('For page ', url)
        const { data, headers } = await axios.get(url, {
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: {
                Authorization: `Bearer ${process.env.GH_TOKEN}`
            }
        });
        if (Array.isArray(data) && data.length == 0) break;
        console.log(data.length)
        results = [...results, ...data];
        page++;
    }

    return results;
}

const getlanguages = async (username) => {
    const repos = await getrepos(username);
    let languageURIs = repos.map((repo) => repo.languages_url);

    console.log("BEFORE", languageURIs.length)
    languageURIs = nodups(languageURIs)
    console.log("AFTER", languageURIs.length)

    let languages = await Promise.all(
        languageURIs.map((lang_uri) => axios.get(lang_uri, {
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: {
                Authorization: `Bearer ${process.env.GH_TOKEN}`
            }
        }))
    )
    languages = languages.map(({ data }) => data)
    console.log(languages.length)
    const bars = githubSortLanguages(languages)
    const stringBars = bars.map((data) => {
        const randIndex = Math.floor(Math.random() * colorPairs.length)
        return `
        ${githubHTML.barOpen} data-percentage="${data.percentage}" 
        style="--bg: ${colorPairs[randIndex][0]}; --text-color:${colorPairs[randIndex][1]}">
        ${data.lang}
        ${githubHTML.divClose}
        `
    });

    return `
        ${githubHTML.style}
        ${githubHTML.mainDivOpen}
        ${stringBars}
        ${githubHTML.divClose}
    `
}

app.get('/getrepos', async (req, res) => {
    try {
        res.send(await getrepos(req.query.username));
    } catch (e) {
        console.log(e)
        res.status(500).json({
            code: '#Error',
            message: e.message,
        })
    }
})

app.get('/getlanguages', async (req, res) => {
    try {
        res.header('Content-Type', 'text/html')
        res.send(await getlanguages(req.query.username));
    } catch (e) {
        console.log(e)
        res.status(500).json({
            code: '#Error',
            message: e.message,
        })
    }
})

module.exports = app