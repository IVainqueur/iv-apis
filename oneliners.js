
/* 
* The following function takes in an array of needed keys and an object and returns
* a new object from the given one that only contains the needed keys

*/
function _pick(needed, theObj) {
    let newObj = {}
    Object.keys(theObj).forEach((key, i) => {
        if (needed.includes(key)) {
            newObj[key] = theObj[key]
        }
    })
    return newObj
}

/* 
* The following function takes in an array of unneeded keys and an object and returns
* a new object from the given one that doesn't contain the unneeded keys

*/

function _remove(unneeded, theObj) {
    let newObj = {}
    Object.keys(theObj).forEach((key, i) => {
        if (!unneeded.includes(key)) {
            newObj[key] = theObj[key]
        }
    })
    return newObj
}

/* 
* The following function takes in an array of unneeded keys and an object and returns
* a new object from the given one that doesn't contain the unneeded keys

*/

function arr_remove(needed, theObj) {
    let newObj = []
    theObj.forEach((value, i) => {
        if (!needed.includes(value)) {
            newObj.push(value)
        }
    })
    return newObj
}

/**
 * @param {string[]} arr 
 */
function nodups(arr) {
    const modified = [];
    for (const el of arr) {
        if (!modified.includes(el)) modified.push(el)
    }
    return modified
}

const githubHTML = {
    style: `
        <style>
            .bar-container{
                display: flex;
                flex-direction: row;
                gap: 5px;
                flex-wrap: wrap;
            }
            .bar {
                padding: 4px 8px;
                border-radius: 20px;
                background-color: var(--bg);
                color: var(--text-color);
                width: fit-content;
                position: relative;
                transition: .1s linear;
                color: white;
            }
            .bar::after{
                transition:inherit;
                content: attr(data-percentage);
                position: absolute;
                top: 100%;
                left: 0;
                background-color: black;
                border: 1px solid rgba(255, 255, 255, 0.494);
                color: white;
                padding: 2px 8px;
                border-radius: 20px;
                scale: 0;
                z-index: 10;
            }

            .bar:hover::after{
                scale: 1;
            }
        </style>
    `,
    mainDivOpen: `<div class="bar-container">`,
    divClose: '</div>',
    barOpen: `<div class="bar"`,
    barClose: `">`
}

const githubSortLanguages = (languages) => {
    const langs = {};
    const tempArr = [];
    let total = 0;
    languages.map((project) => {
        Object.keys(project).map((key, i) => {
            // tempArr.push([key, Object.values(project)[i]])
            total += Object.values(project)[i];
            if (Object.keys(langs).includes(key)) return langs[key].total += Object.values(project)[i];
            langs[key] = { total: Object.values(project)[i] };
        })
    })

    Object.keys(langs).map((lang, i)=>{
        tempArr.push({
            lang,
            total: Object.values(langs)[i].total,
            percentage: ((Object.values(langs)[i].total/total)*100).toString().slice(0, 4) + "%"
        })
    })
    console.log(tempArr, total)
    return tempArr
}

module.exports._pick = _pick
module.exports._remove = _remove
module.exports.arr_remove = arr_remove
module.exports.nodups = nodups
module.exports.githubHTML = githubHTML
module.exports.githubSortLanguages = githubSortLanguages