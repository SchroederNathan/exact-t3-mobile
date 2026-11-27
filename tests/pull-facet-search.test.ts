import {expect,test} from "bun:test";
import {facetSearchRows,hostFacetChoices} from "../pull-facet-search";

test("search suggestions keep selected labels, reserve room for the host and prefer a loaded color",()=>{
  const options = Array.from({length:120},(_,index)=>({id:`match-${index}`,title:`match-${index}`,color:"",selected:false}));
  options[0]!.color = "#ffffff";
  const remote = hostFacetChoices("labels",{labels:[{name:"MATCH-0",color:"123abc"},{name:"host",color:"#AABBCC"},{name:"odd",color:"invalid"},{}]});
  const rows = facetSearchRows(["pinned"],options,remote,"match");
  expect(rows).toHaveLength(100);
  expect(rows[0]).toMatchObject({id:"pinned",selected:true});
  expect(rows[1]).toMatchObject({id:"match-0",color:"#ffffff"});
  expect(rows[51]).toMatchObject({id:"host",color:"#AABBCC"});
  expect(rows[52]?.color).toBe("");
  expect(hostFacetChoices("authors",{authors:[{login:"offpage"}]})).toEqual([{id:"offpage",title:"offpage",color:"",selected:false}]);
});
