#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

static std::string utf8(const wchar_t *text) {
    const int count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (count <= 1) return {};
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), count, nullptr, nullptr);
    result.pop_back();
    return result;
}

static std::string device_key(const DXGI_ADAPTER_DESC1 &adapter) {
    DISPLAYCONFIG_ADAPTER_NAME name{};
    name.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME;
    name.header.size = sizeof(name);
    name.header.adapterId = adapter.AdapterLuid;
    if (DisplayConfigGetDeviceInfo(&name.header) == ERROR_SUCCESS && name.adapterDevicePath[0])
        return utf8(name.adapterDevicePath);
    char id[48];
    std::snprintf(id, sizeof(id), "%04x-%04x-%08x-%02x",
                  adapter.VendorId, adapter.DeviceId, adapter.SubSysId, adapter.Revision);
    return id;
}

static bool same_adapter(LUID first, LUID second) {
    return first.HighPart == second.HighPart && first.LowPart == second.LowPart;
}

int main() {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return 1;
    std::vector<LUID> preferred;
    ComPtr<IDXGIFactory6> ranked;
    if (SUCCEEDED(factory.As(&ranked))) {
        for (UINT index = 0;; index++) {
            ComPtr<IDXGIAdapter1> adapter;
            if (FAILED(ranked->EnumAdapterByGpuPreference(index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                                                       IID_PPV_ARGS(&adapter)))) break;
            DXGI_ADAPTER_DESC1 info{};
            if (SUCCEEDED(adapter->GetDesc1(&info))) preferred.push_back(info.AdapterLuid);
        }
    }
    for (UINT index = 0;; index++) {
        ComPtr<IDXGIAdapter> adapter;
        if (FAILED(factory->EnumAdapters(index, &adapter))) break;
        ComPtr<IDXGIAdapter1> extended;
        DXGI_ADAPTER_DESC1 info{};
        if (FAILED(adapter.As(&extended)) || FAILED(extended->GetDesc1(&info)) ||
            (info.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) ||
            FAILED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), nullptr))) continue;
        const auto match = std::find_if(preferred.begin(), preferred.end(),
                                        [&](LUID luid) { return same_adapter(luid, info.AdapterLuid); });
        const auto rank = match == preferred.end() ? preferred.size() + index : match - preferred.begin();
        std::printf("%u\t%zu\t%s\t%s\n", index, static_cast<size_t>(rank),
                    device_key(info).c_str(), utf8(info.Description).c_str());
    }
    return 0;
}
