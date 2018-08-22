/*********
Helper to translate Amazon commands to Domoticz commands
******/

const env = require('dotenv').config();
const http = require('http');
const https = require('http');
const { LIST_DEVICE_REQUEST, 
		STATE_REQUEST, 
		SET_COMMAND, 
		DEVICE_HANDLER_COMMANDS_PARAMS
	} = require("./config/domoticzCommands")
const { DOMOTICZ_ALEXA_DISCOVERY_MAPPING, 
		ALEXAMAPPING
	} = require("./config/mapping")

const { DOMOTICZ_GET_DEVICES, 
		DOMOTICZ_STATE_ANSWER, 
	} = require("./mockups/domoticzMockups")

const {getUserData} = require("./config/database");
const {decrypt} = require("./config/security");


const PROD_MODE = process.env.PROD_MODE === "true" ? true : false;

// get Domoticz credentials corresponding to the token
async function getBase(token){
	console.log("getBase")
	try {
		const user_data = await getUserData(token);
		if(!user_data)
			throw "Token Error";
		
		const password = decrypt(user_data.domoticzPassword);
		return `http://${user_data.domoticzLogin}:${password}@${user_data.domoticzHost}:${user_data.domoticzPort}/json.htm`
	}catch(e){
		throw e.message;
	}
	
	}

function promiseHttpRequest (request) {
    return new Promise ((resolve, reject) => {
        http.get(request, (resp) => {
          let data = '';
          // A chunk of data has been recieved.
          resp.on('data', (chunk) => {
            data += chunk;
          });
        
          // The whole response has been received. Print out the result.
          resp.on('end', () => {
            console.log("END PROMISE");
            resolve(data);
          });
        
        }).on('socket', (s) => { 
        	s.setTimeout(2000, () => { 
        		console.log("TIMEOUT")
        		s.destroy(); 
        	})
    	}).on("error", (err) => {
	          console.log("Error: " + err.message);
	          reject(err);
	        })
    })
}

//configure an Alexa device
//Domoticz device json is provided and an array of alexa mapping json 
// the function will search the matching mapping and fill the data with domoticz data
// Alexa mapping is a "template" with magic words which should be replaced by domoticz data
function configureAlexaDevice(domoDevice, alexaMapping) {
	//deep clone alexaMapping
	console.log("-----configure---------")
	let alexaDeviceJson = JSON.stringify(alexaMapping);
	const varRegex = /@[^@#]*@/gm;
	const varToReplace =  alexaDeviceJson.match(varRegex);//get all data to retrieve from Domoticz
	console.log(alexaDeviceJson);
	console.log(varToReplace);
	//foreach data to replace, get the corresponding value in domoticz
	varToReplace.forEach((toReplace)=>{
		// @level@ => level
		const domoticzVar = toReplace.replace(new RegExp("@", 'g'),"");
 		// get the var from tomoticz and replace it in mapping json
		alexaDeviceJson = alexaDeviceJson.replace(toReplace,domoDevice[domoticzVar])
	});
	const newDiscovery =  JSON.parse(alexaDeviceJson);
  	
  return newDiscovery;

}

function mapDomoToAlexa(domoDevice,alexaMapping){
	let result = null;
	console.log("mapping device --------")

	alexaMapping.forEach((alexaMap) =>{
      const alexaDevice = alexaMap.domoticz_mapping;
			if(	alexaDevice.Type && alexaDevice.Type === domoDevice.Type &&
				(!alexaDevice.Subtype || alexaDevice.Subtype === domoDevice.SubType )&&
				(!alexaDevice.Switchtype|| alexaDevice.Switchtype === domoDevice.SwitchType)
				)
			{
      console.log("---------mapping----------");
      console.log(domoDevice);
				result = configureAlexaDevice(domoDevice,alexaMap);
		console.log("---------END mapping----------");		
        return ;
			}
		});
	return result;
}

function mapDomoticzDevices(domoDevices,alexaMapping){
		const mappedDevices = [];
		domoDevices.forEach( (domoDevice)=>{
    	const result = mapDomoToAlexa(domoDevice,alexaMapping);
    	result ? mappedDevices.push(result) : null;
	});

	return mappedDevices;
}

async function getDevices(token,domoticzDeviceId) {
	const deviceFilter = domoticzDeviceId ? "&rid="+domoticzDeviceId:"";
	const base = await getBase(token);
	const request = base+"?"+LIST_DEVICE_REQUEST + deviceFilter;
	console.log("getDevices " + request);
	const devicesJsonList = await promiseHttpRequest(request);
	const devicesObjList = JSON.parse(devicesJsonList);
	return devicesObjList.result;
}

function buildDevices(devices) {
	const mappedDevices = mapDomoticzDevices(devices,ALEXAMAPPING);

	return mappedDevices;
}

async function alexaDiscoveryEndpoints(request){
	const requestToken = request.directive.payload.scope.token;
	const devices = await getDevices(requestToken);
	const builtDevices = buildDevices(devices);
	console.log("-----disco-----");
	console.log(builtDevices);
	const discoveryContext = builtDevices.map((device)=>{
		if(!device) return;

		const capabilitiesHeader = [{
                          "type": "AlexaInterface",
                          "interface": "Alexa",
                          "version": "3"
                        }];
		const capabilitiesDetails = device.capabilities.map((capa)=>{
			return {
                "interface": capa.interface,
                "version": "3",
                "type": "AlexaInterface",
                "properties": {
                    "supported": capa.supported,
                     "retrievable": capa.retrievable,
                     "proactivelyReported": capa.proactivelyReported,
                }
             };
		});
		return {
                ...device.discovery,
                "capabilities": capabilitiesHeader.concat(capabilitiesDetails),
             }
	});
	const endPoints = {
            endpoints: discoveryContext,
        };
	console.log("answer ---------- ");
	console.log(JSON.stringify(endPoints));

    return endPoints;
}


/********* EXPORT FILES  *****************************/

exports.alexaDiscovery = alexaDiscoveryEndpoints;
exports.PROD_MODE = PROD_MODE

//return alexa format state for a given alexa format device
exports.getStateFromAlexaDevice =function(alexaDevice) {
	console.log("GET STATE")
	console.log(alexaDevice)
	const properties = alexaDevice.capabilities.map((capability)=>{
			const alexaInterface = capability.interface;
			const alexaSupported = capability.supported.map((support)=>{
				const supportedName = support.name;
				support.value = eval(support.value);
				return  {
					      "namespace": alexaInterface,
					      ...support,
					      "timeOfSample": new Date().toISOString(),
					      "uncertaintyInMilliseconds": 500
					    }
			});
			return alexaSupported;
		});

	const contextResult = {
                "properties": properties
            };

    return contextResult;
}

//send alexa response and stop lambda by context.succeed call
exports.sendAlexaCommandResponse = function(request,context,contextResult){
	const endpointId = request.directive.endpoint.endpointId;
    let responseHeader = request.directive.header;
    responseHeader.namespace = "Alexa";
    responseHeader.name = "Response";
    responseHeader.messageId = responseHeader.messageId + "-R";
    // get user token pass in request
    const requestToken = request.directive.endpoint.scope.token;

    const response = {
        context: contextResult,
        event: {
            header: responseHeader,
            endpoint: {
                scope: {
                    type: "BearerToken",
                    token: requestToken
                },
                endpointId: endpointId
            },
            payload: {}
        }
    };
    console.log("DEBUG: " + responseHeader.namespace + JSON.stringify(response));
    PROD_MODE ? context.succeed(response) : null;
}

//send command to the device handler (ex domoticz)
exports.sendDeviceCommand = async function (request, value){
	console.log("send device command");
	const requestToken = request.directive.endpoint.scope.token;
	const base = await getBase(requestToken);
	let deviceRequest = base + "?" + SET_COMMAND;
	let cookieInfos = request.directive.endpoint.cookie;
	let deviceCommandValue = value;
	const requestMethod = request.directive.header.name;
	const overrideParams = cookieInfos.overrideParams;
	const overrideValue = cookieInfos.overrideValue;
	const deviceId = request.directive.endpoint.endpointId.split("_")[0];
	//const params = overrideParams && typeof overrideParams === "function" ? overrideParams(requestMethod) : DEVICE_HANDLER_COMMANDS_PARAMS[requestMethod];
	const paramsMapper =DEVICE_HANDLER_COMMANDS_PARAMS[requestMethod];
	deviceRequest += `&idx=${deviceId}&${paramsMapper["command"]}`;

	if(deviceCommandValue && paramsMapper["value"])
		deviceRequest += `&${paramsMapper["value"]}=${deviceCommandValue}`

	console.log(deviceRequest);

	try {
		PROD_MODE ? await promiseHttpRequest(deviceRequest) : null ;
		console.log("REQUEST SENT");
		return "ok";
	}catch(e){
		throw e;
	}

}

//return an alexa device using an alexa command using the alexa endpointId
exports.getAlexaDevice= async function (requestToken,endpointId){
	const domoticzId = endpointId.split("_")[0];
	console.log("getDevicesState, domo id " + domoticzId);
	const domoticzState = await getDevices(requestToken,domoticzId);
	if(! domoticzState) return null;
	const alexaDevice = mapDomoToAlexa(domoticzState[0],ALEXAMAPPING);

	return alexaDevice;
}

console.log("RUNNING PROD : " + (PROD_MODE ? "ON" : "OFF"));
