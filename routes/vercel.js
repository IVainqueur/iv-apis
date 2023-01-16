const app = require('express').Router()
const Canvas = require('canvas');



const textInfo = (text = "undefined", _width) => {
    // calculate the height, width, and number of lines
    const font = "20px Arial";
    const padding = 0;

    const linesArray = text.split(/(\n|<br\s*\/?>)+/);
    let totalLines = 0;
    let maxWidth = 0;

    for (let i = 0; i < linesArray.length; i++) {
        const tempCanvas = Canvas.createCanvas(200, 200);
        const tempCtx = tempCanvas.getContext("2d");

        tempCtx.font = font;
        tempCtx.textAlign = "left";
        const textWidth = tempCtx.measureText(linesArray[i]).width;
        const lines = Math.ceil((textWidth + padding * 2) / _width);
        totalLines += lines;
        if (textWidth > maxWidth) maxWidth = textWidth;
    }

    return {
        width: maxWidth,
        height: totalLines * 20,
        lines: totalLines,
    };
};

app.get('/measureText', (req, res) => {
    const { text } = req.query;
    res.json(textInfo(text, 800))
})

module.exports = app