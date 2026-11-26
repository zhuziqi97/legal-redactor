#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int vulkan_gpu(void) {
    void *library = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) return 1;
    PFN_vkGetInstanceProcAddr entry = (PFN_vkGetInstanceProcAddr)dlsym(library, "vkGetInstanceProcAddr");
    if (!entry) return 1;
    PFN_vkCreateInstance create = (PFN_vkCreateInstance)entry(NULL, "vkCreateInstance");
    VkApplicationInfo application = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .apiVersion = VK_API_VERSION_1_1 };
    VkInstanceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &application };
    VkInstance instance;
    if (!create || create(&info, NULL, &instance) != VK_SUCCESS) return 1;

    PFN_vkEnumeratePhysicalDevices enumerate = (PFN_vkEnumeratePhysicalDevices)entry(instance, "vkEnumeratePhysicalDevices");
    PFN_vkGetPhysicalDeviceProperties properties = (PFN_vkGetPhysicalDeviceProperties)entry(instance, "vkGetPhysicalDeviceProperties");
    PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)entry(instance, "vkDestroyInstance");
    uint32_t count = 0;
    int status = 1;
    if (enumerate(instance, &count, NULL) == VK_SUCCESS && count) {
        VkPhysicalDevice *devices = calloc(count, sizeof(*devices));
        if (devices && enumerate(instance, &count, devices) == VK_SUCCESS) {
            for (uint32_t index = 0; index < count; index++) {
                VkPhysicalDeviceProperties device;
                properties(devices[index], &device);
                if (device.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ||
                    device.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU ||
                    device.deviceType == VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU) {
                    puts(device.deviceName);
                    status = 0;
                }
            }
        }
        free(devices);
    }
    destroy(instance, NULL);
    dlclose(library);
    return status;
}

static int cuda_devices(void) {
    void *library = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) return 1;
    int (*init)(unsigned int) = dlsym(library, "cuInit");
    int (*count_devices)(int *) = dlsym(library, "cuDeviceGetCount");
    int (*device_at)(int *, int) = dlsym(library, "cuDeviceGet");
    int (*device_name)(char *, int, int) = dlsym(library, "cuDeviceGetName");
    typedef struct { unsigned char bytes[16]; } CudaUuid;
    int (*device_uuid)(CudaUuid *, int) = dlsym(library, "cuDeviceGetUuid_v2");
    if (!device_uuid) device_uuid = dlsym(library, "cuDeviceGetUuid");
    int count;
    if (!init || !count_devices || !device_at || !device_name || !device_uuid ||
        init(0) != 0 || count_devices(&count) != 0) return 1;
    for (int index = 0; index < count; index++) {
        int device;
        char name[256];
        CudaUuid uuid;
        if (device_at(&device, index) != 0 || device_name(name, sizeof(name), device) != 0 ||
            device_uuid(&uuid, device) != 0) continue;
        printf("%d\t", index);
        for (size_t byte = 0; byte < sizeof(uuid.bytes); byte++) printf("%02x", uuid.bytes[byte]);
        printf("\t%s\n", name);
    }
    dlclose(library);
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    if (strcmp(argv[1], "vulkan") == 0) return vulkan_gpu();
    if (strcmp(argv[1], "cuda") == 0) return cuda_devices();
    return 1;
}
