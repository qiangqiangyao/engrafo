var async = require("async");
var childProcess = require("child_process");
var distill = require("distill-template");
var fs = require("fs-extra");
var jsdom = require("jsdom");
var path = require("path");
var readline = require("readline");

var io = require("./io");
var math = require("./math");
var postprocessors = require("./postprocessor");

var unlinkIfExists = function(path) {
  try {
    fs.unlinkSync(path);
  } catch(err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
};

// render a document with latexml
exports.renderLatexml = (texPath, outputDir, callback) => {
  var htmlPath = path.join(outputDir, "index.html");

  var latexmlc = childProcess.spawn("latexmlc", [
      "--dest", htmlPath,
      "--format", "html5",
      "--mathtex",
      "--svg",
      "--verbose",
      "--preload", "/app/latexml/engrafo.ltxml",
      "--preload", "/usr/src/latexml/lib/LaTeXML/Package/hyperref.sty.ltxml",
      texPath
    ], {
      cwd: path.dirname(texPath)
  });
  latexmlc.on("error", callback);

  var stdoutReadline = readline.createInterface({input: latexmlc.stdout});
  stdoutReadline.on("line", console.log);
  var stderrReadline = readline.createInterface({input: latexmlc.stderr});
  stderrReadline.on("line", console.error);

  latexmlc.on("close", code => {
    if (code !== 0) {
      callback(new Error(`latexmlc exited with status ${code}`));
      return;
    }

    // HACK: Clean up stuff we don't want
    unlinkIfExists(path.join(outputDir, "LaTeXML.cache"));
    unlinkIfExists(path.join(outputDir, "LaTeXML.css"));
    unlinkIfExists(path.join(outputDir, "ltx-article.css"));
    unlinkIfExists(path.join(outputDir, "ltx-listings.css"));

    return callback(null, htmlPath);
  });

};

// Run postprocessing against a string of HTML
exports.postprocess = htmlString => {
  var dom = jsdom.jsdom(htmlString, {
    features: { ProcessExternalResources: false, FetchExternalResources: false }
  });

  // Check there is actually a document to process
  var ltxDocument = dom.querySelector('.ltx_document');
  if (!ltxDocument) {
    throw new Error("Could not find .ltx_document");
  }
  // Title and metadata is always present
  if (ltxDocument.children.length == 0) {
    throw new Error("Document is blank");
  }

  // Document state
  var data = {};

  // Run all processing on document.
  //
  // Order is important -- typically the Engrafo processor comes before the
  // Distill one so that we can massage the LaTeXML output into the format
  // that Distill expects.
  postprocessors.layout(dom, data);
  distill.components.html(dom, data);
  postprocessors.styles(dom, data);
  postprocessors.metadata(dom, data);
  postprocessors.code(dom, data);
  postprocessors.figures(dom, data);
  postprocessors.math(dom, data);
  postprocessors.headings(dom, data);
  postprocessors.appendix(dom, data);
  postprocessors.footnotes(dom, data);
  distill.components.footnote(dom, data);
  postprocessors.bibliography(dom, data);
  distill.components.appendix(dom, data);
  distill.components.typeset(dom, data);
  postprocessors.typeset(dom, data);
  distill.components.hoverBox(dom, data);
  postprocessors.tables(dom, data);
  postprocessors.lists(dom, data);
  postprocessors.links(dom, data);
  postprocessors.container(dom, data);

  return jsdom.serializeDocument(dom);
};

// Do all processing on the file that LaTeXML produces
exports.processHTML = (htmlPath, callback) => {
  async.waterfall([
    (callback) => {
      fs.readFile(htmlPath, "utf8", callback);
    },
    (htmlString, callback) => {
      try {
        htmlString = exports.postprocess(htmlString);
      } catch(err) {
        return callback(err);
      }
      callback(null, htmlString);
    },
    (htmlString, callback) => {
      math.renderMath(htmlString, callback);
    },
    (htmlString, callback) => {
      fs.writeFile(htmlPath, htmlString, callback);
    }
  ], callback);
};

// Render and postprocess a LaTeX file into outputDir (created if does not
// exist). Calls callback with an error on failure or a path to an HTML file
// on success.
exports.render = ({input, output, postProcessing}, callback) => {
  if (postProcessing === undefined) {
    postProcessing = true;
  }

  var texPath, outputDir, htmlPath;
  async.waterfall([
    (callback) => {
      io.prepareInputDirectory(input, callback);
    },
    (inputDir, callback) => {
      io.pickLatexFile(inputDir, callback);
    },
    (_texPath, callback) => {
      texPath = _texPath;

      io.prepareOutputDirectory(output, callback);
    },
    (_outputDir, callback) => {
      outputDir = _outputDir;
      console.log(`Rendering tex file ${texPath} to ${outputDir}`);
      exports.renderLatexml(texPath, outputDir, callback);
    },
    (_htmlPath, callback) => {
      htmlPath = _htmlPath;
      if (postProcessing) {
        exports.processHTML(htmlPath, callback);
      } else {
        callback();
      }
    },
    (callback) => {
      if (output.startsWith('s3://')) {
        io.uploadOutputToS3(outputDir, output, callback);
      } else {
        callback();
      }
    }
  ], (err) => {
    callback(err, htmlPath);
  });
};
