/*
    Copyright (c) 2004-2013, The Dojo Foundation All Rights Reserved.
    Available via Academic Free License >= 2.1 OR the modified BSD license.
    see: http://dojotoolkit.org/license for details
*/
var url = require('url');
var path = require('path');
var qs = require('querystring');
var resourceloader = require('./resourceloader');
var zlib = require('zlib');
var analyzer = require('./analyzer');
var jsp = require("uglify-js").parser;
var pro = require("uglify-js").uglify;
var util = require("./util");

var compressedCache = {};

function getBestFitLocale(localeHeader) {
    var localeRegex = /([a-z]{1,8}(-[a-z]{1,8})?)\s*(;\s*q\s*=\s*(1|0\.[0-9]+))?/i;
    var locales = localeHeader.split(',');
    var bestFitQfactor = 0;
    var bestFitLocale = "";
    for (var i = 0; i < locales.length; i++) {
        var matches = localeRegex.exec(locales[i]);
        var qfactor = parseFloat(matches[4]) || 1.0;
        if (qfactor > bestFitQfactor) {
        	bestFitQfactor = qfactor;
        	bestFitLocale = matches[1];
        }
    }
	return bestFitLocale;
};

var ResponseWriter = function(request, response){
	this.request = request;
	this.response = response;
	this.usegzip = false;
	var encoding = request.headers["accept-encoding"];
	if (encoding && encoding.match(/\bgzip\b/)) {
		this.usegzip = true;
		this.buffer = "";
		this.response.writeHead(200, { 'content-encoding': 'gzip' });
	}
};
		
ResponseWriter.prototype = {
	write: function(content) {
		if (this.usegzip) {
			this.buffer += content;
		} else {
			this.response.write(content);
		}
	},
	end: function() {
		if (this.usegzip) {
			var scope = this;
			zlib.gzip(this.buffer, function(error, buffer){
				if (!error) {
					scope.response.write(buffer);
				} else {
					console.log("Failed to gzip :"+error);
				}
				scope.response.end();
			});
		} else {
			this.response.end();
		}
	}
};

function lookForMissingName(uri, missingNamesList) {
    var missingNameIndex = -1;
    for (var i = 0; i < missingNamesList.length; i++) {
        if (uri === missingNamesList[i].uri) {
            missingNameIndex = missingNamesList[i].nameIndex;
            break;
        }
    }
    return missingNameIndex;
};

function getMissingNameId(uri, missingNamesList) {
	var id = null;
    for (var i = 0; i < missingNamesList.length; i++) {
        if (uri === missingNamesList[i].uri) {
            id = missingNamesList[i].id;
            break;
        }
    }
	return id;
};

function writeLocalizations(responseWriter, localizations, locale) {
	var intermediateLocale = null;
	if (locale.indexOf('-') !== -1) {
		intermediateLocale = locale.split('-')[0];
	}
	for (var i = 0; i < localizations.length; i++) {
		var rootModule = path.normalize(localizations[i].bundlepackage).replace(/\\/g, "/");
		var fullModule = path.normalize(localizations[i].modpath+'/'+locale+'/'+localizations[i].bundlename).replace(/\\/g, "/");
		if (intermediateLocale !== null) {
			var intermediateModule = path.normalize(localizations[i].modpath+'/'+intermediateLocale+'/'+localizations[i].bundlename).replace(/\\/g, "/");
		}
		resourceloader.readText(rootModule+".js", function(root){
			if (root) {
				writeLocalization(responseWriter, root, rootModule);
			}
		});
		if (intermediateModule !== null) {
			resourceloader.readText(intermediateModule+".js", function(lang) {
				if (lang) {
					writeLocalization(responseWriter, lang, intermediateModule);
				}
			});
		}
		resourceloader.readText(fullModule+".js", function(langCountry) {
			if (langCountry) {
				writeLocalization(responseWriter, langCountry, fullModule);
			}
		});
	}
};

function writeLocalization(responseWriter, content, moduleName) {
	var str = content.substring(0, content.indexOf('(')+1);
	str += "'";
	str += moduleName;
	str += "',";
	str += content.substring(content.indexOf('(')+1);
	str += "\n";
	responseWriter.write(str);
};

function writeResponse(params, analysisData, excludes, request, response, config, compressContent) {
	response.setHeader('ETag', analysisData.checksum);
	response.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
	var responseWriter = new ResponseWriter(request, response);
	var writeBootstrap = params.writeBootstrap;
	if (writeBootstrap && writeBootstrap === true) {
		for (var i = 0; i < bootstrapModulePaths.length; i++) {
			var bootstrapModulePath = path.normalize(bootstrapModulePaths[i]);
	        if (compressContent) {
				resourceloader.getTimestamp(bootstrapModulePath, function(ts) {
					var cacheEntry = compressedCache[bootstrapModulePath];
					if (cacheEntry && cacheEntry.ts === ts) {
						responseWriter.write(cacheEntry.content);
					} else {
						resourceloader.readText(bootstrapModulePath, function(text) {
							var compressed = compress(text);
							responseWriter.write(compressed);
							compressedCache[bootstrapModulePath] = {content: compressed, ts: ts};
						});
					}
				});
	        } else {
	        	resourceloader.readText(bootstrapModulePath, function(text) {
		        	responseWriter.write(text);
	        	});
	        }
		}
	}
	responseWriter.write("zazl.addAnalysisKey('"+analysisData.key+"');\n");
	
	var i;
	var exludeAnalysisData;
	var pluginRefs;
	var pluginRefList;
	var pluginRef;
	var seen = {};
	var localizations = [];
	
	var i18nPluginId = config.amdconfig["i18nPluginId"];
	
	if (i18nPluginId) {
		for (i = 0; i < excludes.length; i++) {
			exludeAnalysisData = analyzer.getAnalysisDataFromKey(excludes[i]);
			pluginRefs = exludeAnalysisData.pluginRefs;
			if (pluginRefs && pluginRefs[i18nPluginId]) {
				pluginRefList = pluginRefs[i18nPluginId];
				for (var j = 0; j < pluginRefList.length; j++) {
					seen[pluginRefList[j].normalizedName] = true;
				}
			}
		}
	}
	
	for (pluginRef in analysisData.pluginRefs) {
		pluginRefList = analysisData.pluginRefs[pluginRef];
		for (i = 0; i < pluginRefList.length; i++) {
			if (pluginRefList[i].value) {
				responseWriter.write(pluginRefList[i].value);
			}
		}
		if (i18nPluginId && i18nPluginId === pluginRef) {
			var bundlePackage;
			var moduleUrl;
			var modulePath;
			var bundleName;
			var localization;
			
			for (i = 0; i < pluginRefList.length; i++) {
				bundlePackage = pluginRefList[i].normalizedName;
				moduleUrl = pluginRefList[i].moduleUrl;
				if (!seen[bundlePackage]) {
					seen[bundlePackage] = true;
					modulePath = bundlePackage.substring(0, bundlePackage.lastIndexOf('/'));
					moduleUrl = moduleUrl.substring(0, moduleUrl.lastIndexOf('/'));
					bundleName = bundlePackage.substring(bundlePackage.lastIndexOf('/')+1);
					localization = {
						bundlepackage: bundlePackage, 
						modpath: modulePath, 
						bundlename: bundleName, 
						moduleurl: moduleUrl 
					};
					localizations.push(localization);
				}
			}
		}
	}
	
	if (localizations.length > 0) {
		writeLocalizations(responseWriter, localizations, getBestFitLocale(request.headers["accept-language"]));
	}

	var callback = util.createCallback(analysisData.dependencyList.length, function() {
		responseWriter.end();
	});
	
	analysisData.dependencyList.forEach(function(dependency) {
		var uri = path.normalize(dependency);
        var dependencyPath = uri+".js";
        resourceloader.getTimestamp(dependencyPath, function(ts) {
        	var keepgoing = true;
			if (compressContent) {
				var cacheEntry = compressedCache[dependency];
				if (cacheEntry && cacheEntry.ts === ts) {
					responseWriter.write(cacheEntry.content);
					callback();
					keepgoing = false;
				}
			}
			if (keepgoing === true) {
				resourceloader.readText(dependencyPath, function(content) {
					var missingNameIndex = lookForMissingName(dependency, analysisData.missingNamesList);
		
					if (missingNameIndex !== -1) {
						var modifiedContent = content.substring(0, missingNameIndex);
						modifiedContent += "'"+getMissingNameId(dependency, analysisData.missingNamesList)+"', ";
						modifiedContent += content.substring(missingNameIndex);
						content = modifiedContent;
					}
					if (analysisData.shims && analysisData.shims[dependency]) {
						content += analysisData.shims[dependency];
					}
					if (compressContent) {
						var compressed = compress(content);
						responseWriter.write(compressed);
						compressedCache[dependency] = {content: compressed, ts: ts};
					} else {
						responseWriter.write(content);
					}
					callback();
				});
			}
        });
	});
};

function compress(content) {
	var ast = jsp.parse(content);
	ast = pro.ast_mangle(ast);
	ast = pro.ast_squeeze(ast, {make_seqs: false});
	var compressed = pro.gen_code(ast);
	if (compressed.charAt(compressed.length-1) === ')') {
		compressed += ";";
    }		
	return compressed;
};

function handle(request, response, config, compress) {
	var requestURL = url.parse(request.url);
	var params = qs.parse(requestURL.query);
	var bootstrapModulePaths = config.bootstrapModules;
	var analysisData;
	if (params.modules !== undefined) {
		var modules = params.modules.split(',');
		var p;
		var excludes = [];
		if (params.exclude) {
			excludes = params.exclude.split(',');
		}
		var fullConfig = {};
		for (p in config.amdconfig) {
			fullConfig[p] = config.amdconfig[p];
		}
		if (params.config) {
			var pageConfig = JSON.parse(params.config);
			for (p in pageConfig) {
				fullConfig[p] = pageConfig[p];
			}
		}
		analyzer.getAnalysisData(modules, excludes, fullConfig, function(analysisData) {
			var ifNoneMatch = request.headers["if-none-match"];
			if (ifNoneMatch !== undefined  && ifNoneMatch === analysisData.checksum) {
				response.writeHead(304, {'Content-Type': 'text/javascript; charset=UTF-8'}); 
				response.end();
				return;
			}
			writeResponse(params, analysisData, excludes, request, response, config, compress);
		});
	}
}

Optimizer = function(appdir, compress) {
	resourceloader.addProvider(appdir);
	this.compress = compress;
	resourceloader.readText("zazlUsingESPrima.json", function(configText) {
		this.config = JSON.parse(configText);
	}.bind(this));
};

Optimizer.prototype = {
	handle: function(request, response) {
		var otherwiseCallback;
	    var errorCallback;
	    
		var handler = {
			otherwise : function(callback) {
				otherwiseCallback = callback;
				return handler;
			},
			error: function(callback) {
				errorCallback = callback;
				return handler;
			}
		};
		var scope = this;
		process.nextTick(function() {
			errorCallback = errorCallback || function(state) {
				response.writeHead(state, {'Content-Type': 'text/html'});
				response.end("<h1>HTTP " + state + "</h1>");
		    };
		    
		    otherwiseCallback = otherwiseCallback || function() {
		    	response.writeHead(404, {'Content-Type': 'text/html'});
		    	response.end("<h1>HTTP 404 File not found</h1>");
		    };
		    
			var requestURL = url.parse(request.url);
			if (requestURL.pathname.match("^/_javascript")) {
				handle(request, response, scope.config, scope.compress);
			} else {
				otherwiseCallback();
			}
		});
		return handler;
	}
};

exports.createOptimizer = function(appdir, compress) {
	return new Optimizer(appdir, compress);
};

ConnectOptimizer = function(appdir, compress) {
	resourceloader.addProvider(appdir);
	this.compress = compress;
	resourceloader.readText("zazlUsingESPrima.json", function(configText) {
		this.config = JSON.parse(configText);
	}.bind(this));
};

ConnectOptimizer.prototype = {
	handle: function(request, response, next) {
		handle(request, response, this.config, this.compress);
	}
};

exports.createConnectOptimizer = function(appdir, compress) {
	return new ConnectOptimizer(appdir, compress);
};

exports.getLoaderDir = function() {
	return path.normalize(__dirname+"/..");
};