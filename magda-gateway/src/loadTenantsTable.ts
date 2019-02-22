import RegistryClient from "../../magda-typescript-common/src/registry/RegistryClient";
import {
    BigInt,
    Tenant
} from "../../magda-typescript-common/src/generated/registry/api";

export default function loadTenantsTable(
    tenantMap: Map<String, BigInt>,
    url: string
) {
    let registryClient = new RegistryClient({ baseUrl: url });
    registryClient.getTenants().then(tenants => {
        let tenantsJson = <Array<Tenant>>tenants;
        tenantsJson.forEach(t => tenantMap.set(t.domainName, t.id));
    });
}
