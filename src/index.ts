/// <reference path="../typings/index.d.ts" />
'use strict';

import * as request from 'superagent';

const packageInfo = require('../package.json');

const oDataQueryNames = ["$select", "$expand", "$orderby", "$filter", "$top", "$skip", "$skipToken", "$count"];
const DEFAULT_VERSION = "v1.0";
const GRAPH_BASE_URL = "https://graph.microsoft.com/";


export interface Options {
    debugLogging?: boolean,
    defaultVersion?: string,
    authProvider?: (done) => void,
    baseUrl: string
}

// http://graph.microsoft.com/VERSION/PATH?QUERYSTRING&OTHER_QUERY_PARAMS
export interface URLComponents {
    host: string
    version: string
    path?: string
    oDataQueryParams:{ [key: string] : string|number; }
    otherURLQueryParams:{ [key: string] : string|number; }
}

export interface GraphRequestCallback {
    (error: GraphError, response: any, rawResponse?: any): void
}

export interface GraphError {
    statusCode: number, // 503
    code: string, // "SearchEvents"
    message: string, // "The parameter $search is not currently supported on the Events resource."
    requestId: string, // "ca269f81-55d7-483f-a9e6-2b04a2a2d0e2"
    date: Date, // new Date(2016-11-17T18:49:59)
    body: string // original graph response
}

export class GraphRequest {
    config: Options;
    urlComponents: URLComponents;
    _headers:{ [key: string] : string|number; } // other headers to pass through to superagent
    _responseType: string;


    constructor(config: Options, path:string) {
        this.config = config;
        this._headers = {};

        this.urlComponents = {
            host: this.config.baseUrl,
            version: this.config.defaultVersion,
            oDataQueryParams: {},
            otherURLQueryParams: {}
        };

        this.parsePath(path);
    }

/*
    Example error for https://graph.microsoft.com/v1.0/me/events?$top=3&$search=foo
    {
        "error": {
            "code": "SearchEvents",
            "message": "The parameter $search is not currently supported on the Events resource.",
            "innerError": {
                "request-id": "b31c83fd-944c-4663-aa50-5d9ceb367e19",
                "date": "2016-11-17T18:37:45"
            }
        }
    }
*/
    public static parseError(rawErr):GraphError {
        let errObj; // path to object containing innerError (see above schema)

        if (!('rawResponse' in rawErr)) { // if superagent correctly parsed the JSON
            if ('error' in rawErr.response.body) { // some 404s don't return an error object
                errObj = rawErr.response.body.error;
            }
        } else {
            // if there was an error parsing the JSON
            // possibly because of http://stackoverflow.com/a/38749510/2517012
            errObj = JSON.parse(rawErr.rawResponse.replace(/^\uFEFF/, '')).error;
        }

        // parse out statusCode
        let statusCode:number;
        if (rawErr.response !== undefined && rawErr.response.status !== undefined) {
            statusCode = rawErr.response.status;
        } else {
            statusCode = rawErr.statusCode;
        }
        
        // if we couldn't find an error obj to parse, just return an object with a status code and date
        if (errObj === undefined) {
            return {
                statusCode,
                code: null,
                message: null,
                requestId: null,
                date: new Date(),
                body: null
            }
        }

        let err:GraphError = {
            statusCode,
            code: errObj.code,
            message: errObj.message,
            requestId: errObj.innerError["request-id"],
            date: new Date(errObj.innerError.date),
            body: errObj
        };

        return err;
    }

    public header(headerKey:string, headerValue:string) {
        this._headers[headerKey] = headerValue;
        return this;
    }

    public headers(headers:{ [key: string] : string|number }) {
        for (let key in headers) {
            this._headers[key] = headers[key];
        }
        return this;
    }

    public parsePath(rawPath:string) {
        // break rawPath into this.urlComponents

        // strip out the base url if they passed it in
        if (rawPath.indexOf("https://")!= -1) {
            rawPath = rawPath.replace("https://", "");

            // find where the host ends
            let endOfHostStrPos = rawPath.indexOf("/");
            this.urlComponents.host = "https://" + rawPath.substring(0, endOfHostStrPos); // parse out the host
            // strip the host from rawPath
            rawPath = rawPath.substring(endOfHostStrPos + 1, rawPath.length);

            // then remove the following version
            let endOfVersionStrPos = rawPath.indexOf("/");
            // parse out the version
            this.urlComponents.version = rawPath.substring(0, endOfVersionStrPos);
            // strip version from rawPath
            rawPath = rawPath.substring(endOfVersionStrPos + 1, rawPath.length);
        }
        
        // strip out any leading "/"
        if (rawPath.charAt(0) == "/") {
            rawPath = rawPath.substr(1);
        }
        
        let queryStrPos = rawPath.indexOf("?");
        // let afterPath = 
        if (queryStrPos == -1) {
            // no query string
            this.urlComponents.path = rawPath;
        } else {
            this.urlComponents.path = rawPath.substr(0, queryStrPos);
            
            // capture query string into
            // this.urlComponents.oDataQueryParams
            // and
            // this.urlComponents.otherURLQueryParams

            let queryParams = rawPath.substring(queryStrPos + 1, rawPath.length).split("&");
            for (let queryParam of queryParams) {
                //queryParam:  a=b
                let param = queryParam.split("="); //@todo add back deconstruction
                let key = param[0];
                let value = param[1];
                if (oDataQueryNames.indexOf(key)) {
                    this.urlComponents.oDataQueryParams[key] = value;
                } else {
                    this.urlComponents.otherURLQueryParams[key] = value;                    
                }
            }
        }
    }

    
    private urlJoin(urlSegments:[string]):String {
        const tr = (s) => s.replace(/\/+$/, '');
        const tl = (s) => s.replace(/^\/+/, '');
        const joiner = (pre, cur) => [tr(pre), tl(cur)].join('/');
        const parts = Array.prototype.slice.call(urlSegments);

        return parts.reduce(joiner);
    }

    public buildFullUrl():string {
        let url = this.urlJoin([this.urlComponents.host,
                                this.urlComponents.version,
                                this.urlComponents.path])
                  + this.createQueryString();

        if (this.config.debugLogging) {
            console.log(url)
        }

        return url;
    }

    version(v:string):GraphRequest {
        this.urlComponents.version = v;
        return this;
    }

    /*
     * Accepts .select("displayName,birthday")
     *     and .select(["displayName", "birthday"])
     *     and .select("displayName", "birthday")
     * 
     */
    select(properties:string|[string]):GraphRequest {
        this.addCsvQueryParamater("$select", properties, arguments);
        return this;
    }

    expand(properties:string|[string]):GraphRequest {
        this.addCsvQueryParamater("$expand", properties, arguments);
        return this;
    }

    orderby(properties:string|[string]):GraphRequest {
        this.addCsvQueryParamater("$orderby", properties, arguments);
        return this;
    }

    
    filter(filterStr:string):GraphRequest {
        this.urlComponents.oDataQueryParams["$filter"] = filterStr;
        return this;
    }

    top(n:number):GraphRequest {
        this.urlComponents.oDataQueryParams["$top"] = n;
        return this;
    }

    skip(n:number):GraphRequest {
        this.urlComponents.oDataQueryParams["$skip"] = n;
        return this;
    }

    skipToken(token:string):GraphRequest {
        this.urlComponents.oDataQueryParams["$skipToken"] = token;
        return this;
    }

    count(count:boolean):GraphRequest {
        this.urlComponents.oDataQueryParams["$count"] = count.toString();
        return this;
    }
    
    responseType(responseType:string):GraphRequest {
        this._responseType = responseType;
        return this;
    }

    // helper for $select, $expand and $orderby (must be comma separated)
    private addCsvQueryParamater(propertyName:string, propertyValue:string|[string], additionalProperties:IArguments) {
        // if there are already $propertyName value there, append a ","
        this.urlComponents.oDataQueryParams[propertyName] = this.urlComponents.oDataQueryParams[propertyName] ? this.urlComponents.oDataQueryParams[propertyName] + "," : "";

        let allValues:string[] = [];

        if (typeof propertyValue === "string") {
            allValues.push(propertyValue);
        } else { // propertyValue passed in as array
            allValues = allValues.concat(propertyValue);
        }

        // merge in additionalProperties
        if (additionalProperties.length > 1 && typeof propertyValue === "string") {
            allValues = Array.prototype.slice.call(additionalProperties);
        }

        this.urlComponents.oDataQueryParams[propertyName] += allValues.join(",");
    }


    delete(callback?:GraphRequestCallback):Promise<any>|void {
        let url = this.buildFullUrl();
        return this.sendRequestAndRouteResponse(request.del(url), callback)
    }

    patch(content:any, callback?:GraphRequestCallback):Promise<any>|void {
        let url = this.buildFullUrl();
        
        return this.sendRequestAndRouteResponse(
            request
                .patch(url)
                .send(content),
            callback
        );
    }

    post(content:any, callback?:GraphRequestCallback):Promise<any>|void {
        let url = this.buildFullUrl();
        return this.sendRequestAndRouteResponse(
            request
                .post(url)
                .send(content),
                callback
        );
    }

    put(content:any, callback?:GraphRequestCallback):Promise<any>|void {
        let url = this.buildFullUrl();
        return this.sendRequestAndRouteResponse(
            request
                .put(url)
                .type('application/octet-stream')
                .send(content),
                callback
        );
    }

    // request aliases
    // alias for post
    create(content:any, callback?:GraphRequestCallback):Promise<any>|void {
        return this.post(content, callback);
    }

    // alias for patch
    update(content:any, callback?:GraphRequestCallback):Promise<any>|void {
        return this.patch(content, callback);
    }

    del(callback?:GraphRequestCallback):Promise<any>|void {
        return this.delete(callback);
    }

    get(callback?:GraphRequestCallback):Promise<any>|void {
        let url = this.buildFullUrl();
        return this.sendRequestAndRouteResponse(
            request
                .get(url),
                callback
        );
    }

    // Given the built SuperAgentRequest, get an auth token from the authProvider, make the request and return a promise
    private routeResponseToPromise(requestBuilder:request.SuperAgentRequest) {
        return new Promise((resolve, reject) => {
            this.routeResponseToCallback(requestBuilder, (err, body) => {
                if (err != null) {
                    reject(err);
                } else {
                    resolve(body);
                }
            });
        });
    }

    // Given the built SuperAgentRequest, get an auth token from the authProvider, make the request and invoke the callback
    private routeResponseToCallback(requestBuilder:request.SuperAgentRequest, callback: GraphRequestCallback) {
        this.config.authProvider((err, accessToken) => {
            if (err == null && accessToken != null) {
                let request = this.configureRequest(requestBuilder, accessToken);
                request.end((err, res) => {
                    this.handleResponse(err, res, callback)
                });
            } else {
                callback(err, null, null);
            }
        });
    }

    /*
     * Help method that's called from the final actions( .get(), .post(), etc.) that after making the request either invokes
     * routeResponseToCallback() or routeResponseToPromise()
     */
    private sendRequestAndRouteResponse(requestBuilder:request.SuperAgentRequest, callback?:GraphRequestCallback):Promise<any>|void {
        // return a promise when Promises are supported and no callback was provided
        if (callback == null && typeof Promise !== "undefined") {
            return this.routeResponseToPromise(requestBuilder);
        } else {
            this.routeResponseToCallback(requestBuilder, callback || function(){});
        }
    }

    getStream(callback:GraphRequestCallback) {
        this.config.authProvider((err, accessToken) => {
            if (err === null && accessToken !== null) {
                let url = this.buildFullUrl();
                callback(null, this.configureRequest(request.get(url), accessToken));
            } else {
                callback(err, null);
            }
        });
    }

    putStream(stream:any, callback:Function) {
        this.config.authProvider((err, accessToken) => {
            if (err === null && accessToken !== null) {
                let url = this.buildFullUrl();
                let req:request.Request = this.configureRequest(request.put(url), accessToken);
                req.type('application/octet-stream');
                stream
                    .pipe(req)
                    .on('error', function(err) {
                        callback(err, null)
                    })
                    .on('end', function() {
                        callback(null)
                    });
            }
        });
    }

    private configureRequest(requestBuilder:request.SuperAgentRequest, accessToken:string):request.SuperAgentRequest {
        let request = requestBuilder
            .set('Authorization', 'Bearer ' + accessToken)
            .set(this._headers)
            .set('SdkVersion', "graph-js-" + packageInfo.version)

        if (this._responseType !== undefined) {
            request.responseType(this._responseType);
        }

        return request;
    }

    getResultIterator() {
        let values = [];
        let nextLink:string;

        let get = (url) => {
            return (callback) => {

                if (values.length > 0) {
                    callback(null, values.splice(0, 1)[0]);
                } else {
                    if (nextLink != null) {
                        url = nextLink;
                    }
                    _this.sendRequestAndRouteResponse(request.get(url), (err, res) => {
                        if (err) {
                            callback(err, null);
                            return;
                        }
                        values = values.concat(res.value);
                        nextLink = res["@odata.nextLink"];
                        callback(null, values.splice(0, 1)[0]);
                    });
                }
            }
        }

        let _this = this;
        return function* () {        
            let url = _this.buildFullUrl();
            while(true) {
                yield get(url);
            }
        }();
    }

    // append query strings to the url, accepts either a string like $select=displayName or a dictionary {"$select": "displayName"}
    query(queryDictionaryOrString:string|{ [key: string] : string|number; }):GraphRequest {
        if (typeof queryDictionaryOrString === "string") { // is string
            let queryStr = queryDictionaryOrString;
            //split .query("$select=displayName") into key and balue
            let queryKey = queryStr.split("=")[0];
            let queryValue = queryStr.split("=")[1];

            this.urlComponents.otherURLQueryParams[queryKey] = queryValue;
        } else { // is dictionary
            for (let key in queryDictionaryOrString) {
                this.urlComponents.otherURLQueryParams[key] = queryDictionaryOrString[key];
            }
        }
        return this;
    }
    
    private handleResponse(err, res, callback:GraphRequestCallback):void {
        if (res && res.ok) { // 2xx
            callback(null, res.body, res)
        } else { // not OK response
            if (err == null && res.error !== null) // if error was passed to body
                callback(GraphRequest.parseError(res), null, res);
            else // pass back error as first param
                callback(GraphRequest.parseError(err), null, res)
        }
    }

    // ex: ?$select=displayName&$filter=startsWith(displayName, 'A')
    // does not include starting ?
    private createQueryString():string {
        // need to combine first this.urlComponents.oDataQueryParams and this.urlComponents.otherURLQueryParams
        let q:string[] = [];

        if (Object.keys(this.urlComponents.oDataQueryParams).length != 0) {
            for (let property in this.urlComponents.oDataQueryParams) {
                q.push(property + "=" + this.urlComponents.oDataQueryParams[property]);
            }
        }
        
        if (Object.keys(this.urlComponents.otherURLQueryParams).length != 0) {
            for (let property in this.urlComponents.otherURLQueryParams) {
                q.push(property + "=" + this.urlComponents.otherURLQueryParams[property]);
            }
        }

        if (q.length > 0) {
            return "?" + q.join("&");
        }

        return "";        
    }
}

module.exports = class MicrosoftGraphClient {
    // specify client defaults
    config:Options = {
        debugLogging: false,
        defaultVersion: DEFAULT_VERSION,
        baseUrl: GRAPH_BASE_URL
    };

    static init(clientOptions:Options) {
        var graphClient = new MicrosoftGraphClient();
        for (let key in clientOptions) {
            graphClient.config[key] = clientOptions[key];
        }
        return graphClient;
    }

    /*
     * Entry point for calling api
     */
    api(path:string) {
        return new GraphRequest(this.config, path);
    }

}